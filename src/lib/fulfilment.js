/*
 * Central order fulfilment and recovery for every purchase path.
 *
 * Money is booked before this module runs. Dispatch is claimed atomically,
 * Rema timeouts remain in-flight until reconciled, and confirmed failures are
 * reversed once. Paystack-backed failures also queue a customer refund.
 */

import { Agent, Customer, Order, Payment, Store, Transaction } from "../models/index.js";
import { recordLog } from "./audit.js";
import { withMongoTransaction } from "./mongoTransaction.js";
import { requestPaystackRefundForOrder } from "./paystackRefund.js";
import {
  remaBuyData,
  remaConfigured,
  remaLive,
  remaOrderByClientReference,
  remaOrderStatus,
  validPhone,
} from "./remaApi.js";

const money = (n) => Math.round(Number(n) * 100) / 100;

const allowSimulatedSales = () =>
  String(process.env.REMA_ALLOW_SIMULATED_SALES || "").toLowerCase() === "true";

/** Claim and deliver a saved order. Safe when called by multiple recovery paths. */
export async function fulfilOrder(inputOrder, reversal) {
  const reversalPlan = reversal
    ? {
        agent: reversal.agent,
        agentName: reversal.agentName || "",
        credit: money(reversal.credit || 0),
        platformClawback: money(reversal.platformClawback || 0),
        agentWalletAdjustment:
          reversal.agentWalletAdjustment == null
            ? undefined
            : money(reversal.agentWalletAdjustment),
        platformWalletAdjustment:
          reversal.platformWalletAdjustment == null
            ? undefined
            : money(reversal.platformWalletAdjustment),
        storeId: reversal.storeId,
      }
    : undefined;

  const set = { provider: "rema", providerStatus: "dispatching", status: "processing" };
  if (reversalPlan) set.reversal = reversalPlan;

  // Only the pending -> processing winner may POST to Rema. This protects
  // callback verification, webhooks and the recovery poller from double-send.
  let order = await Order.findOneAndUpdate(
    { _id: inputOrder._id, status: "pending" },
    { $set: set },
    { new: true }
  );
  if (!order) {
    order = await Order.findById(inputOrder._id);
    return { status: order?.status || inputOrder.status, alreadyDispatched: true };
  }

  if (!remaLive()) {
    if (!allowSimulatedSales()) {
      return settleFailed(
        order,
        remaConfigured()
          ? "Fulfilment is switched off, so this bundle was not sent."
          : "The fulfilment provider is not configured, so this bundle was not sent."
      );
    }
    order.provider = "simulated";
    order.providerStatus = "simulated";
    order.providerMessage = "Simulated sale. Nothing was sent.";
    order.status = "completed";
    order.deliveredAt = new Date();
    await order.save();
    await markPaymentFulfilled(order);
    return { status: order.status, simulated: true };
  }

  if (!validPhone(order.phone)) {
    return settleFailed(order, "No valid recipient number on this order.");
  }

  const result = await remaBuyData({
    ref: order.ref,
    phone: order.phone,
    carrier: order.carrier,
    gb: order.gb,
  });

  // POST timeouts are ambiguous. Rema may have accepted and charged the order,
  // so never refund or send a duplicate until its client reference is found.
  if (result.indeterminate) {
    order.providerStatus = "unknown";
    order.providerMessage = result.message;
    order.status = "processing";
    await order.save();
    recordLog(
      "warning",
      `Rema purchase outcome unknown · ${order.ref} · awaiting reconciliation`,
      "fulfilment"
    );
    return { status: order.status, indeterminate: true, message: result.message };
  }

  if (!result.ok) {
    return settleFailed(order, result.message || "The provider rejected this order.");
  }

  order.provider = "rema";
  order.providerRef = result.providerRef;
  order.providerStatus = result.status;
  order.providerMessage = result.message;
  order.providerCost = money(result.cost || 0);
  order.status = result.status;
  if (result.status === "completed") order.deliveredAt = new Date();
  await order.save();

  if (result.status === "completed") await markPaymentFulfilled(order);
  if (["completed", "processing"].includes(result.status)) {
    recordLog(
      "info",
      `Order sent to Rema · ${order.ref} · ${order.carrier} ${order.gb}GB → ${order.phone}`,
      "fulfilment",
      { providerRef: order.providerRef, cost: order.providerCost }
    );
    return { status: order.status };
  }

  return settleFailed(order, result.message || "The provider could not deliver this order.");
}

async function markPaymentFulfilled(order) {
  if (!order.paymentReference) return;
  await Payment.updateOne(
    { reference: order.paymentReference, status: { $nin: ["refund_pending", "refunded"] } },
    { $set: { status: "fulfilled" } }
  );
}

async function settleFailed(order, message) {
  order.provider = order.provider || "rema";
  order.providerStatus = "failed";
  order.providerMessage = message;
  order.status = "failed";
  await order.save();

  const reversed = await reverseOrder(order);
  recordLog(
    "warning",
    `Order not delivered · ${order.ref} · ${order.carrier} ${order.gb}GB · ${message}`,
    "fulfilment",
    { reversed }
  );
  return { status: reversed ? "refunded" : order.status, message };
}

/** Atomically undo internal accounting once, then queue any gateway refund. */
export async function reverseOrder(inputOrder) {
  if (inputOrder.reversedAt || !inputOrder.reversal?.agent) return false;

  const reversed = await withMongoTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      {
        _id: inputOrder._id,
        $or: [{ reversedAt: { $exists: false } }, { reversedAt: null }],
      },
      { $set: { status: "refunded", reversedAt: new Date() } },
      { new: true, session }
    );
    if (!order) return false;

    const { agent: agentId, agentName, credit, platformClawback, storeId } = order.reversal;
    const agentAdjustment = Number.isFinite(order.reversal.agentWalletAdjustment)
      ? money(order.reversal.agentWalletAdjustment)
      : money(credit || 0);
    const platformAdjustment = Number.isFinite(order.reversal.platformWalletAdjustment)
      ? money(order.reversal.platformWalletAdjustment)
      : money(-(platformClawback || 0));
    const label = `${order.carrier} ${order.gb}GB${order.phone ? ` · ${order.phone}` : ""}`;

    if (agentAdjustment !== 0) {
      const agent = await Agent.findByIdAndUpdate(
        agentId,
        { $inc: { wallet: agentAdjustment } },
        { new: true, session }
      );
      if (agent) {
        await Transaction.create(
          [
            {
              agentId,
              agent: agentName || agent.name || "Agent",
              store: order.store,
              type: "refund",
              description: `Order reversal · ${order.ref} · ${label}`,
              amount: agentAdjustment,
              reference: `${order.ref}-refund-agent`,
            },
          ],
          { session }
        );
      }
    }

    if (platformAdjustment !== 0) {
      const superadmin = await Agent.findOne({ role: "superadmin" })
        .sort({ createdAt: 1 })
        .session(session);
      if (superadmin) {
        await Agent.updateOne(
          { _id: superadmin._id },
          { $inc: { wallet: platformAdjustment } },
          { session }
        );
        await Transaction.create(
          [
            {
              agentId: superadmin._id,
              agent: superadmin.name,
              store: order.store,
              type: "refund",
              description: `Platform margin reversed · ${order.ref} · ${label}`,
              amount: platformAdjustment,
              reference: `${order.ref}-refund-platform`,
            },
          ],
          { session }
        );
      }
    }

    if (storeId) {
      await Store.updateOne(
        { _id: storeId },
        { $inc: { orders: -1, revenue: -order.amount } },
        { session }
      );
    }
    if (order.phone) {
      await Customer.updateOne(
        { agent: agentId, phone: order.phone },
        { $inc: { orders: -1, spent: -order.amount } },
        { session }
      );
    }
    return true;
  });

  if (reversed && inputOrder.paymentReference) {
    await requestPaystackRefundForOrder(
      inputOrder,
      inputOrder.providerMessage || "Data order was not delivered"
    );
  }
  return reversed;
}

/** Recover undispatched orders and reconcile Rema orders still in flight. */
export async function syncPendingOrders({ limit = 50 } = {}) {
  const undispatched = await Order.find({ status: "pending" }).sort({ createdAt: 1 }).limit(limit);
  for (const order of undispatched) await fulfilOrder(order);

  // A database outage during reversal must not leave a charged failed order
  // stranded forever. Retry only the atomic internal reversal; the refund
  // helper has its own one-time claim.
  const unreversed = await Order.find({
    status: "failed",
    "reversal.agent": { $exists: true, $ne: null },
    $or: [{ reversedAt: { $exists: false } }, { reversedAt: null }],
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  for (const order of unreversed) await reverseOrder(order);

  if (!remaLive()) {
    return { checked: undispatched.length + unreversed.length, delivered: 0, failed: unreversed.length };
  }

  const pending = await Order.find({ provider: "rema", status: "processing" })
    .sort({ createdAt: 1 })
    .limit(limit);

  let delivered = 0;
  let failed = 0;
  for (const order of pending) {
    const result = order.providerRef
      ? await remaOrderStatus(order.providerRef)
      : await remaOrderByClientReference(order.ref);
    if (!result.ok || result.status === "processing") continue;

    if (!order.providerRef && result.providerRef) order.providerRef = result.providerRef;
    order.providerStatus = result.raw || result.status;
    if (result.status === "completed") {
      order.status = "completed";
      order.deliveredAt = new Date();
      await order.save();
      await markPaymentFulfilled(order);
      delivered++;
      continue;
    }

    order.providerMessage = result.message || `Provider reported ${result.raw || "failed"}.`;
    await settleFailed(order, order.providerMessage);
    failed++;
  }

  return {
    checked: pending.length + undispatched.length + unreversed.length,
    delivered,
    failed: failed + unreversed.length,
  };
}

let pollerTimer = null;

export function startFulfilmentPoller() {
  const seconds = Number(process.env.REMA_POLL_SECONDS ?? 90);
  if (pollerTimer || !Number.isFinite(seconds) || seconds <= 0) return pollerTimer;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncPendingOrders();
    } catch (err) {
      console.error("⚠ Fulfilment sync failed:", err?.message || err);
    } finally {
      running = false;
    }
  };

  void run();
  pollerTimer = setInterval(run, seconds * 1000);
  pollerTimer.unref?.();
  return pollerTimer;
}
