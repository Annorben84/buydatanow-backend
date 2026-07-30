/*
 * Order fulfilment — hands a paid order to Rema Data and settles the outcome.
 *
 * Every purchase path (agent Buy Data, storefront wallet, storefront Paystack)
 * funnels through `fulfilOrder`, so delivery, refunds and the ledger behave the
 * same everywhere. Rema accepts an order as "pending" and delivers moments
 * later, so an order can also settle asynchronously — `syncPendingOrders`
 * polls the ones still in flight and reverses the money for any that failed.
 */

import { Agent, Order, Store, Customer, Transaction } from "../models/index.js";
import { recordLog } from "./audit.js";
import {
  remaBuyData,
  remaOrderStatus,
  remaLive,
  remaConfigured,
  validPhone,
} from "./remaApi.js";

const money = (n) => Math.round(n * 100) / 100;

/**
 * Whether an order may be marked delivered without actually being sent. Off by
 * default: it books real money against wallets, so it belongs to a disposable
 * development database only — never one with live agent balances in it.
 */
const allowSimulatedSales = () =>
  String(process.env.REMA_ALLOW_SIMULATED_SALES || "").toLowerCase() === "true";

/**
 * Deliver a paid order and record the outcome on it.
 *
 * With fulfilment switched off (local development — see REMA_FULFILMENT) no
 * provider call is made and the order completes as "simulated", so the whole
 * flow can be exercised without spending the Rema float.
 *
 * @param {import("mongoose").Document} order  A saved Order.
 * @param {object} [reversal]  What to put back if the provider can't deliver:
 *   `{ agent, agentName, credit, platformClawback, storeId }`. Omit for orders
 *   where nothing was charged.
 * @returns {Promise<{status: string, simulated?: boolean, message?: string}>}
 */
export async function fulfilOrder(order, reversal) {
  if (reversal) {
    order.reversal = {
      agent: reversal.agent,
      agentName: reversal.agentName || "",
      credit: money(reversal.credit || 0),
      platformClawback: money(reversal.platformClawback || 0),
      storeId: reversal.storeId,
    };
  }

  if (!remaLive()) {
    // Settling an unsent order as "completed" still debits the buyer's wallet
    // and books store revenue — real money for data nobody received. That is
    // only ever acceptable against a throwaway database, so it takes an
    // explicit opt-in; everywhere else the sale is refused and refunded.
    if (!allowSimulatedSales()) {
      return settleFailed(
        order,
        remaConfigured()
          ? "Fulfilment is switched off (REMA_FULFILMENT), so this bundle was not sent."
          : "The fulfilment provider is not configured, so this bundle was not sent."
      );
    }
    order.provider = "simulated";
    order.providerStatus = "simulated";
    order.providerMessage = "Simulated — REMA_ALLOW_SIMULATED_SALES is on. Nothing was sent.";
    order.status = "completed";
    order.deliveredAt = new Date();
    await order.save();
    return { status: order.status, simulated: true };
  }

  // A wrong or missing recipient burns real money at the provider, so refuse
  // before sending rather than after.
  if (!validPhone(order.phone)) {
    return settleFailed(order, "No valid recipient number on this order.");
  }

  const result = await remaBuyData({
    ref: order.ref,
    phone: order.phone,
    carrier: order.carrier,
    gb: order.gb,
  });

  if (!result.ok) {
    return settleFailed(order, result.message || "The provider rejected this order.");
  }

  order.provider = "rema";
  order.providerRef = result.providerRef;
  order.providerStatus = result.status;
  order.providerMessage = result.message;
  order.providerCost = money(result.cost || 0);
  order.status = result.status; // "processing" until Rema confirms delivery
  if (result.status === "completed") order.deliveredAt = new Date();
  await order.save();

  if (result.status === "completed" || result.status === "processing") {
    recordLog(
      "info",
      `Order sent to Rema · ${order.ref} · ${order.carrier} ${order.gb}GB → ${order.phone}`,
      "fulfilment",
      { providerRef: order.providerRef, cost: order.providerCost }
    );
    return { status: order.status };
  }

  // Rema answered OK but with a terminal status (e.g. already refunded).
  return settleFailed(order, result.message || "The provider could not deliver this order.");
}

/** Mark an order undeliverable, put the money back, and log it. */
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
    { refunded: reversed }
  );
  return { status: order.status, message };
}

/**
 * Undo the money movement recorded when the order was placed: credit the
 * buyer's wallet, claw the platform margin back off the app owner, and roll
 * the store/customer counters back. Idempotent via `reversedAt`.
 *
 * Exported so support can settle an order that was booked but never delivered
 * — see POST /api/admin/orders/:ref/reverse.
 */
export async function reverseOrder(order) {
  if (order.reversedAt || !order.reversal?.agent) return false;

  const { agent: agentId, agentName, credit, platformClawback, storeId } = order.reversal;
  const label = `${order.carrier} ${order.gb}GB${order.phone ? ` · ${order.phone}` : ""}`;

  if (credit > 0) {
    const agent = await Agent.findById(agentId);
    if (agent) {
      agent.wallet = money(agent.wallet + credit);
      await agent.save();
    }
    await Transaction.create({
      agentId,
      agent: agentName || agent?.name || "Agent",
      store: order.store,
      type: "refund",
      description: `Refund · undelivered order ${order.ref} · ${label}`,
      amount: credit,
      reference: `${order.ref}-refund`,
    });
  }

  if (platformClawback > 0) {
    const superadmin = await Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 });
    if (superadmin) {
      superadmin.wallet = money(superadmin.wallet - platformClawback);
      await superadmin.save();
      await Transaction.create({
        agentId: superadmin._id,
        agent: superadmin.name,
        store: order.store,
        type: "refund",
        description: `Platform margin reversed · ${order.ref} · ${label}`,
        amount: -platformClawback,
        reference: `${order.ref}-refund-platform`,
      });
    }
  }

  if (storeId) {
    await Store.updateOne({ _id: storeId }, { $inc: { orders: -1, revenue: -order.amount } });
  }
  if (order.phone) {
    await Customer.updateOne(
      { agent: agentId, phone: order.phone },
      { $inc: { orders: -1, spent: -order.amount } }
    );
  }

  order.status = "refunded";
  order.reversedAt = new Date();
  await order.save();
  return true;
}

/**
 * Poll Rema for orders still in flight and settle the ones that finished.
 * Safe to call repeatedly — only touches orders it sent and hasn't settled.
 */
export async function syncPendingOrders({ limit = 50 } = {}) {
  if (!remaLive()) return { checked: 0, delivered: 0, failed: 0 };

  const pending = await Order.find({
    provider: "rema",
    status: "processing",
    providerRef: { $nin: [null, ""] },
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  let delivered = 0;
  let failed = 0;

  for (const order of pending) {
    const result = await remaOrderStatus(order.providerRef);
    if (!result.ok || result.status === "processing") continue;

    order.providerStatus = result.raw || result.status;

    if (result.status === "completed") {
      order.status = "completed";
      order.deliveredAt = new Date();
      await order.save();
      delivered++;
      continue;
    }

    order.status = "failed";
    order.providerMessage = result.message || `Provider reported ${result.raw || "failed"}.`;
    await order.save();
    await reverseOrder(order);
    failed++;
    recordLog(
      "warning",
      `Order failed at the provider · ${order.ref} · ${order.carrier} ${order.gb}GB`,
      "fulfilment",
      { providerRef: order.providerRef, providerStatus: order.providerStatus }
    );
  }

  return { checked: pending.length, delivered, failed };
}

/**
 * Start the background status poller. No-op unless fulfilment is live and
 * REMA_POLL_SECONDS is above zero (default 90s).
 */
export function startFulfilmentPoller() {
  const seconds = Number(process.env.REMA_POLL_SECONDS ?? 90);
  if (!remaLive() || !Number.isFinite(seconds) || seconds <= 0) return null;

  const timer = setInterval(() => {
    syncPendingOrders().catch((err) =>
      console.error("⚠ Fulfilment sync failed:", err?.message || err)
    );
  }, seconds * 1000);
  timer.unref?.(); // never hold the process open
  return timer;
}
