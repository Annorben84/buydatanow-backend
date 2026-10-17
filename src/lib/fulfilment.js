/*
 * Central order fulfilment and recovery for every purchase path.
 *
 * Money is booked before this module runs. Dispatch is claimed atomically,
 * Netpluse timeouts remain in-flight until reconciled, and confirmed failures are
 * reversed once. Paystack-backed failures also queue a customer refund.
 */

import { Agent, Customer, Order, Payment, Store, Transaction } from "../models/index.js";
import { recordLog } from "./audit.js";
import { withMongoTransaction } from "./mongoTransaction.js";
import { requestPaystackRefundForOrder } from "./paystackRefund.js";
import { platformCollectedEarnings } from "./platformEarnings.js";
import { syncPendingCheckerPurchases } from "./checkerPurchases.js";
import {
  netpluseBuyData,
  netpluseConfigured,
  netpluseLive,
  netpluseOrderStatus,
  netpluseSimulatedSalesAllowed,
  isProviderThrottle,
  validPhone,
} from "./netpluseApi.js";

const money = (n) => Math.round(Number(n) * 100) / 100;
const inFlightStatuses = ["processing", "on_hold"];

// A status request holds a snapshot while waiting on the provider. It may write
// only while the saved order is still in flight and has not been reversed.
async function updateInFlightOrder(order, values) {
  return Order.findOneAndUpdate(
    { _id: order._id, status: { $in: inFlightStatuses }, reversedAt: null },
    { $set: values },
    { new: true }
  );
}

async function savedOrderResult(order) {
  const saved = await Order.findById(order._id);
  return { status: saved?.status || order.status, message: saved?.providerMessage || "" };
}

export function canReverseOrder(order) {
  return (
    ["failed", "cancelled"].includes(order.status) ||
    (order.status === "completed" && order.provider === "simulated" && !order.earningsSettledAt)
  );
}

/**
 * Release platform-collected order earnings only after confirmed delivery.
 * The order claim makes this safe across callbacks, polling, and retries.
 */
export async function settleCompletedOrderEarnings(inputOrder) {
  if (
    inputOrder.status !== "completed" ||
    inputOrder.settlementModel !== "platform_collected" ||
    inputOrder.earningsSettledAt
  ) {
    return false;
  }

  return withMongoTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      {
        _id: inputOrder._id,
        status: "completed",
        settlementModel: "platform_collected",
        earningsSettledAt: null,
      },
      { $set: { earningsSettledAt: new Date() } },
      { new: true, session }
    );
    if (!order) return false;

    const agent = await Agent.findById(order.agent).session(session);
    if (!agent) throw new Error(`Cannot settle earnings for ${order.ref}: agent not found.`);

    const rows = [];
    const saleLabel = order.store || "Portal purchase";
    const payment = order.paymentReference
      ? await Payment.findOne({ reference: order.paymentReference }).session(session)
      : null;
    const earnings = platformCollectedEarnings({
      agentMargin: order.earning,
      platformMargin: order.platformEarning,
      chargedAmount: payment?.chargedAmount,
      principal: payment?.amount,
      gatewayFee: payment?.gatewayFee,
    });
    const agentMargin = earnings.agentCommission;
    if (agentMargin > 0) {
      await Agent.updateOne(
        { _id: agent._id },
        { $inc: { commissionAvailable: agentMargin } },
        { session }
      );
      rows.push({
        agentId: agent._id,
        agent: agent.name,
        store: order.store,
        type: "commission",
        description: `${saleLabel} commission earned · ${order.carrier} ${order.gb}GB`,
        amount: agentMargin,
        reference: `${order.ref}-margin`,
      });
    }

    const {
      feeRecovery,
      gatewayFee,
      platformMargin,
      platformNet,
    } = earnings;
    const superadmin = await Agent.findOne({ role: "superadmin" })
      .sort({ createdAt: 1 })
      .session(session);

    if (superadmin) {
      if (platformNet !== 0) {
        await Agent.updateOne(
          { _id: superadmin._id },
          { $inc: { wallet: platformNet } },
          { session }
        );
      }
      if (platformMargin !== 0) {
        rows.push({
          agentId: superadmin._id,
          agent: superadmin.name,
          store: order.store,
          type: platformMargin > 0 ? "commission" : "fee",
          description: `${platformMargin > 0 ? "Platform margin" : "Platform price subsidy"} · ${saleLabel} · ${order.carrier} ${order.gb}GB`,
          amount: platformMargin,
          reference: `${order.ref}-${platformMargin > 0 ? "platform" : "platform-subsidy"}`,
        });
      }
      if (feeRecovery > 0) {
        rows.push({
          agentId: superadmin._id,
          agent: superadmin.name,
          store: order.store,
          type: "fee",
          description: `Paystack fee paid by customer · ${saleLabel}`,
          amount: feeRecovery,
          reference: `${order.ref}-paystack-fee-recovery`,
        });
      }
      if (gatewayFee > 0) {
        rows.push({
          agentId: superadmin._id,
          agent: superadmin.name,
          store: order.store,
          type: "fee",
          description: `Paystack fee · ${saleLabel}`,
          amount: -gatewayFee,
          reference: `${order.ref}-paystack-fee`,
        });
      }
    }

    if (rows.length) await Transaction.create(rows, { session, ordered: true });
    return true;
  });
}

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
        newCustomer: Boolean(reversal.newCustomer),
      }
    : undefined;

  const set = { provider: "netpluse", providerStatus: "dispatching", status: "processing" };
  if (reversalPlan) set.reversal = reversalPlan;

  // Only the pending -> processing winner may POST to Netpluse. This protects
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

  if (!netpluseLive()) {
    if (!netpluseSimulatedSalesAllowed()) {
      return settleFailed(
        order,
        netpluseConfigured()
          ? "Fulfilment is switched off, so this bundle was not sent."
          : "The fulfilment provider is not configured, so this bundle was not sent."
      );
    }
    const completed = await updateInFlightOrder(order, {
      provider: "simulated", providerStatus: "simulated",
      providerMessage: "Simulated sale. Nothing was sent.",
      status: "completed", deliveredAt: new Date(),
    });
    if (!completed) return savedOrderResult(order);
    order = completed;
    await settleCompletedOrderEarnings(order);
    await markPaymentFulfilled(order);
    return { status: order.status, simulated: true };
  }

  if (!validPhone(order.phone)) {
    return settleFailed(order, "No valid recipient number on this order.");
  }

  const result = await netpluseBuyData({
    ref: order.ref,
    phone: order.phone,
    carrier: order.carrier,
    gb: order.gb,
  });

  // POST timeouts/rate limits are ambiguous. Netpluse may have charged the order,
  // so never refund or send a duplicate until its client reference is found.
  if (result.indeterminate) {
    const waiting = await updateInFlightOrder(order, {
      providerStatus: "unknown", providerMessage: result.message, status: "processing",
    });
    if (!waiting) return savedOrderResult(order);
    order = waiting;
    recordLog(
      "warning",
      `Netpluse purchase outcome unknown · ${order.ref} · awaiting reconciliation`,
      "fulfilment"
    );
    return { status: order.status, indeterminate: true, message: result.message };
  }

  if (!result.ok) {
    return settleFailed(order, result.message || "The provider rejected this order.");
  }

  const provider = {
    provider: "netpluse", providerRef: result.providerRef,
    providerStatus: result.raw || result.status, providerMessage: result.message,
    providerCost: money(result.cost || 0),
  };
  if (!["completed", ...inFlightStatuses].includes(result.status)) {
    return settleFailed(order, result.message || "The provider could not deliver this order.", provider);
  }
  const updated = await updateInFlightOrder(order, {
    ...provider, status: result.status,
    ...(result.status === "completed" ? { deliveredAt: new Date() } : {}),
  });
  if (!updated) return savedOrderResult(order);
  order = updated;

  if (result.status === "completed") {
    await settleCompletedOrderEarnings(order);
    await markPaymentFulfilled(order);
  }
  recordLog(
    "info",
    `Order sent to Netpluse · ${order.ref} · ${order.carrier} ${order.gb}GB → ${order.phone}`,
    "fulfilment",
    { providerRef: order.providerRef, cost: order.providerCost }
  );
  return { status: order.status };
}

async function markPaymentFulfilled(order) {
  if (!order.paymentReference) return;
  await Payment.updateOne(
    { reference: order.paymentReference, status: { $nin: ["refund_pending", "refund_failed", "refunded"] } },
    { $set: { status: "fulfilled" } }
  );
}

async function settleFailed(order, message, provider = {}) {
  const failed = await updateInFlightOrder(order, {
    provider: order.provider || "netpluse", providerStatus: "failed", ...provider,
    providerMessage: message, status: "failed",
  });
  if (!failed) return savedOrderResult(order);
  const reversed = await reverseOrder(failed);
  const saved = await savedOrderResult(failed);
  recordLog(
    "warning",
    `Order failure reconciled · ${order.ref} · ${order.carrier} ${order.gb}GB · ${saved.status} · ${message}`,
    "fulfilment",
    { reversed, status: saved.status }
  );
  return { status: saved.status, message: saved.message || message };
}

/** Atomically undo internal accounting once, then queue any gateway refund. */
export async function reverseOrder(inputOrder) {
  if (inputOrder.reversedAt || !inputOrder.reversal?.agent || !canReverseOrder(inputOrder)) return false;

  // Verify accepted orders again before moving money. This also recovers old
  // failed records caused by temporary throttles, before a refund is booked.
  if (
    inputOrder.status === "failed" && inputOrder.provider === "netpluse" &&
    (inputOrder.providerRef || isProviderThrottle(inputOrder.providerMessage))
  ) {
    const live = await netpluseOrderStatus(inputOrder.providerRef || inputOrder.ref);
    if (!live.ok) return false;
    if (!["failed", "refunded"].includes(live.status)) {
      const recovered = await Order.findOneAndUpdate(
        { _id: inputOrder._id, status: "failed", reversedAt: null },
        { $set: {
          status: live.status, providerRef: inputOrder.providerRef || live.providerRef,
          providerStatus: live.raw || live.status,
          providerMessage: live.message || "Netpluse is still processing this order; no refund was issued.",
          ...(live.status === "completed" ? { deliveredAt: inputOrder.deliveredAt || new Date() } : {}),
        } },
        { new: true }
      );
      if (recovered?.status === "completed") {
        await settleCompletedOrderEarnings(recovered);
        await markPaymentFulfilled(recovered);
      }
      return false;
    }
  }

  // A user cancellation has its own terminal state. Provider failures still
  // settle as refunded, while a cancelled order remains visibly cancelled
  // after the same accounting reversal is applied.
  const reversedStatus = inputOrder.status === "cancelled" ? "cancelled" : "refunded";

  const reversed = await withMongoTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      {
        _id: inputOrder._id,
        status: inputOrder.status,
        ...(inputOrder.status === "completed" ? { provider: "simulated", earningsSettledAt: null } : {}),
        $or: [{ reversedAt: { $exists: false } }, { reversedAt: null }],
      },
      { $set: { status: reversedStatus, reversedAt: new Date() } },
      { new: true, session }
    );
    if (!order) return false;

    const { agent: agentId, agentName, credit, platformClawback, storeId, newCustomer } = order.reversal;
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
      if (!agent) throw new Error(`Cannot refund ${order.ref}: buyer account not found.`);
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
          { session, ordered: true }
        );
      }
    }

    if (platformAdjustment !== 0) {
      const superadmin = await Agent.findOne({ role: "superadmin" })
        .sort({ createdAt: 1 })
        .session(session);
      if (!superadmin) throw new Error(`Cannot reverse ${order.ref}: platform account not found.`);
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
          { session, ordered: true }
        );
      }
    }

    if (storeId) {
      await Store.updateOne(
        { _id: storeId },
        {
          $inc: {
            orders: -1,
            revenue: -order.amount,
            customers: newCustomer ? -1 : 0,
          },
        },
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

  if (reversed && inputOrder.paymentProvider === "paystack" && inputOrder.paymentReference) {
    await requestPaystackRefundForOrder(
      inputOrder,
      inputOrder.providerMessage || "Data order was not delivered"
    );
  } else if (reversed && inputOrder.paymentReference) {
    await Payment.updateOne(
      { reference: inputOrder.paymentReference },
      {
        $set: {
          status: "refunded",
          failureReason: inputOrder.providerMessage || "Data order was not delivered",
        },
      }
    );
  }
  return reversed;
}

/**
 * Ask Netpluse for one order's current state and reconcile the local record.
 * This is shared by the background poller and the authenticated agent order
 * view, so both paths apply exactly the same delivery/refund rules.
 */
export async function syncNetpluseOrder(inputOrder) {
  let order = inputOrder;

  if (order.status === "pending") {
    await fulfilOrder(order);
    order = await Order.findById(order._id);
  }

  if (!order || order.provider !== "netpluse") {
    return {
      checked: false,
      ok: true,
      status: order?.status || inputOrder.status,
      message:
        order?.provider === "simulated"
          ? "This order was completed in simulated mode and was not sent to Netpluse."
          : "This order has not been sent to Netpluse.",
    };
  }

  if (!order.providerRef && !inFlightStatuses.includes(order.status)) {
    return {
      checked: false,
      ok: true,
      status: order.status,
      message: "This order does not have a Netpluse reference.",
    };
  }

  // An accepted POST can lose its response before we save the provider reference.
  // Look up our original idempotency reference first; a missing local reference
  // is never proof that we should send another purchase request.
  let result = await netpluseOrderStatus(order.providerRef || order.ref);
  if (
    result.notFound &&
    !order.providerRef &&
    inFlightStatuses.includes(order.status) &&
    netpluseLive()
  ) {
    result = await netpluseBuyData({
      ref: order.ref,
      phone: order.phone,
      carrier: order.carrier,
      gb: order.gb,
    });
  }

  if (!result.ok) {
    // Even a rejected retry cannot prove the original timed-out POST failed.
    // Keep checking its reference; only a confirmed order status can refund it.
    await updateInFlightOrder(order, {
      providerMessage: result.message || "Could not read the live Netpluse order status.",
    });
    const saved = await savedOrderResult(order);
    return {
      checked: true,
      ok: false,
      status: saved.status,
      message: result.message || "Could not read the live Netpluse order status.",
    };
  }

  const provider = {
    providerRef: order.providerRef || result.providerRef,
    providerStatus: result.raw || result.status,
    providerMessage: result.message || order.providerMessage,
    providerCost: money(result.cost || order.providerCost || 0),
  };
  const liveOrder = {
    network: result.network || order.carrier || "",
    capacity: result.capacity || order.bundle || "",
    createdAt: result.createdAt || null,
  };

  // Terminal local orders are queried for visibility, but never reversed or
  // reopened by a later provider response. Only in-flight orders reconcile.
  if (!inFlightStatuses.includes(order.status)) {
    return {
      checked: true,
      ok: true,
      status: result.status,
      raw: result.raw || result.status,
      message: result.message || "Live status fetched from Netpluse.",
      providerRef: order.providerRef,
      ...liveOrder,
    };
  }

  if (inFlightStatuses.includes(result.status)) {
    const updated = await updateInFlightOrder(order, { ...provider, status: result.status });
    if (!updated) return { checked: true, ok: true, ...await savedOrderResult(order) };
    order = updated;
    return {
      checked: true,
      ok: true,
      status: order.status,
      raw: result.raw || result.status,
      message: result.message || (order.status === "on_hold"
        ? "Netpluse has placed this order on hold. Delivery is paused; we will keep checking for updates."
        : "Netpluse is still processing this order."),
      providerRef: order.providerRef,
      ...liveOrder,
    };
  }

  if (result.status === "completed") {
    const updated = await updateInFlightOrder(order, {
      ...provider, status: "completed", deliveredAt: order.deliveredAt || new Date(),
    });
    if (!updated) return { checked: true, ok: true, ...await savedOrderResult(order) };
    order = updated;
    await settleCompletedOrderEarnings(order);
    await markPaymentFulfilled(order);
    return {
      checked: true,
      ok: true,
      status: order.status,
      raw: result.raw || result.status,
      message: result.message || "Netpluse confirmed delivery.",
      providerRef: order.providerRef,
      ...liveOrder,
    };
  }

  const failure = await settleFailed(order, result.message || `Provider reported ${result.raw || "failed"}.`, provider);
  return {
    checked: true,
    ok: true,
    status: failure.status,
    raw: result.raw || result.status,
    message: failure.message,
    providerRef: provider.providerRef,
    ...liveOrder,
  };
}

/** Recover undispatched orders and reconcile Netpluse orders still in flight. */
export async function syncPendingOrders({ limit = 50 } = {}) {
  const undispatched = await Order.find({ status: "pending" }).sort({ createdAt: 1 }).limit(limit);
  for (const order of undispatched) await fulfilOrder(order);

  const unsettledEarnings = await Order.find({
    status: "completed",
    settlementModel: "platform_collected",
    earningsSettledAt: null,
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  for (const order of unsettledEarnings) await settleCompletedOrderEarnings(order);

  // A database outage during reversal must not leave a charged failed or
  // cancelled order stranded forever. Retry only the atomic internal reversal;
  // the refund helper has its own one-time claim.
  const unreversed = await Order.find({
    status: { $in: ["failed", "cancelled"] },
    "reversal.agent": { $exists: true, $ne: null },
    $or: [{ reversedAt: { $exists: false } }, { reversedAt: null }],
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  for (const order of unreversed) await reverseOrder(order);
  const unreversedFailures = unreversed.filter((order) => order.status === "failed").length;

  if (!netpluseLive()) {
    return {
      checked: undispatched.length + unreversed.length + unsettledEarnings.length,
      delivered: unsettledEarnings.length,
      failed: unreversedFailures,
    };
  }

  const pending = await Order.find({ provider: "netpluse", status: { $in: inFlightStatuses } })
    .sort({ updatedAt: 1, createdAt: 1 })
    .limit(limit);

  let delivered = 0;
  let failed = 0;
  for (const order of pending) {
    const result = await syncNetpluseOrder(order);
    if (result.status === "completed") delivered++;
    if (["failed", "refunded"].includes(result.status)) failed++;
  }

  return {
    checked: pending.length + undispatched.length + unreversed.length + unsettledEarnings.length,
    delivered,
    failed: failed + unreversedFailures,
  };
}

let pollerTimer = null;

export function startFulfilmentPoller() {
  const seconds = Number(process.env.NETPLUSE_POLL_SECONDS ?? 90);
  if (pollerTimer || !Number.isFinite(seconds) || seconds <= 0) return pollerTimer;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncPendingOrders();
      await syncPendingCheckerPurchases();
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
