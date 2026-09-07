import { randomUUID } from "node:crypto";
import { Agent, Transaction, Payment } from "../models/index.js";
import { CheckerPurchase } from "../models/CheckerPurchase.js";
import { getSettings } from "./settings.js";
import { withMongoTransaction } from "./mongoTransaction.js";
import { requestPaystackRefundForPayment } from "./paystackRefund.js";
import { netpluseConfigured, netpluseCheckers, netplusePurchaseCheckers, netpluseCheckerPurchase, netpluseCheckerOrderStatus } from "./netpluseApi.js";

const money = (n) => Math.round(Number(n) * 100) / 100;
const openStatuses = ["pending", "processing"];
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function validateCheckerPurchase(body) {
  const { type, quantity, reference } = body || {};
  if (!["waec", "bece"].includes(type)) throw problem("Choose WAEC or BECE.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw problem("Choose a whole quantity between 1 and 50.");
  if (typeof reference !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(reference)) throw problem("A valid purchase reference is required.");
  return { type, quantity, reference };
}

export async function checkerCatalog(role = "agent") {
  if (!netpluseConfigured()) throw problem("Result checkers are temporarily unavailable.", 503);
  const [rows, settings] = await Promise.all([netpluseCheckers(), getSettings()]);
  return rows.filter((row) => ["waec", "bece"].includes(row.id)).map((row) => ({
    type: row.id, name: row.name, description: row.description, available: row.available,
    baseCost: money(row.price),
    unitPrice: money(row.price + (role === "superadmin" ? 0 : Number(settings[`${row.id}CheckerMargin`]) || 0)),
    maxQuantity: 50,
  }));
}

function sameIntent(existing, input) {
  if (existing.type !== input.type || existing.quantity !== input.quantity) {
    throw problem("This reference belongs to a different purchase. Start a new purchase.", 409);
  }
  return existing;
}

/** The debit and durable purchase intent are atomic, before any provider request. */
export async function reserveCheckerPurchase(agent, body) {
  const input = validateCheckerPurchase(body);
  const filter = { agent: agent._id, clientReference: input.reference };
  const ownedWalletPurchase = { ...filter, channel: { $ne: "public" } };
  const existing = await CheckerPurchase.findOne(ownedWalletPurchase);
  if (existing) return sameIntent(existing, input);
  const item = (await checkerCatalog(agent.role)).find((row) => row.type === input.type);
  if (!item?.available) throw problem("That result checker is currently unavailable.", 409);
  if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0) throw problem("That checker has no valid selling price.", 409);
  // An outdated screen never silently charges a new price.
  if (money(body.unitPrice) !== item.unitPrice) throw problem("The price changed. Refresh prices and confirm the new total.", 409);
  const amount = money(item.unitPrice * input.quantity);
  try {
    return await withMongoTransaction(async (session) => {
      const duplicate = await CheckerPurchase.findOne(ownedWalletPurchase).session(session);
      if (duplicate) return sameIntent(duplicate, input);
      const buyer = await Agent.findOneAndUpdate(
        { _id: agent._id, status: "active", wallet: { $gte: amount } },
        { $inc: { wallet: -amount } }, { new: true, session }
      );
      if (!buyer) throw problem("Your wallet balance is too low for this purchase.");
      const reference = `CHK-${randomUUID()}`;
      const [purchase] = await CheckerPurchase.create([{
        ...filter, reference, type: input.type, quantity: input.quantity,
        unitPrice: item.unitPrice, amount, providerCost: money(item.baseCost * input.quantity),
        isSuperadmin: agent.role === "superadmin",
      }], { session, ordered: true });
      await Transaction.create([{
        agentId: buyer._id, agent: buyer.name, type: "purchase", amount: -amount,
        description: `${input.type.toUpperCase()} result checker × ${input.quantity}`,
        reference: `${reference}-purchase`,
      }], { session, ordered: true });
      return purchase;
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await CheckerPurchase.findOne(ownedWalletPurchase);
      if (duplicate) return sameIntent(duplicate, input);
    }
    throw error;
  }
}

export function checkerResponse(json, purchase) {
  const data = json?.data || json || {};
  if ((data.type && data.type !== purchase.type) || (data.quantity != null && Number(data.quantity) !== purchase.quantity)
    || (purchase.providerReference && data.reference && data.reference !== purchase.providerReference)) {
    return { valid: false, pins: [], status: "" };
  }
  const pins = Array.isArray(data.pins) ? data.pins.filter((pin) => pin && (pin.serial != null || pin.pin != null)).map((pin) => ({
    serial: String(pin.serial ?? ""), pin: String(pin.pin ?? ""), expires: String(pin.expires ?? ""),
  })) : [];
  const total = Number(data.total_cost);
  return {
    valid: true, pins, status: String(data.status || "").toLowerCase(),
    reference: typeof data.reference === "string" ? data.reference : "",
    providerCost: data.total_cost != null && Number.isFinite(total) && total >= 0 ? money(total) : undefined,
  };
}

export function completeCheckerPins(purchase) {
  return purchase.pins?.length === purchase.quantity && purchase.pins.every((pin) => pin.serial && pin.pin)
    && new Set(purchase.pins.map((pin) => `${pin.serial}:${pin.pin}`)).size === purchase.quantity;
}

/** PINs have already been saved before financial settlement is attempted. */
export async function settleCheckerPurchase(id) {
  return withMongoTransaction(async (session) => {
    const purchase = await CheckerPurchase.findById(id).select("+pins").session(session);
    if (!purchase || purchase.settledAt) return purchase;
    const completed = completeCheckerPins(purchase);
    const failed = !purchase.pins.length && ["failed", "refunded"].includes(purchase.providerStatus);
    if (!completed && !failed) return purchase;
    if (purchase.channel === "public") {
      const payment = await Payment.findOne({ reference: purchase.paymentReference }).session(session);
      if (!payment) throw new Error("Checker payment not found.");
      if (failed) {
        purchase.status = "refund_pending";
        purchase.message = "Delivery failed. A refund to your payment method is being arranged.";
      } else {
        const agentCommission = money(purchase.agentMargin || 0);
        if (agentCommission > 0) {
          const seller = await Agent.findByIdAndUpdate(purchase.agent, { $inc: { commissionAvailable: agentCommission } }, { new: true, session });
          if (!seller) throw new Error("Checker seller not found.");
          await Transaction.create([{
            agentId: seller._id, agent: seller.name, type: "commission", amount: agentCommission,
            description: `${purchase.type.toUpperCase()} checker storefront commission`, reference: `${purchase.reference}-agent-margin`,
          }], { session, ordered: true });
        }
        const margin = money(purchase.amount - agentCommission - purchase.providerCost);
        const feeRecovery = money((payment.chargedAmount ?? payment.amount) - payment.amount);
        const fee = money(payment.gatewayFee || 0);
        const admin = await Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 }).session(session);
        if (!admin) throw new Error("Superadmin account is required to settle checker earnings.");
        await Agent.updateOne({ _id: admin._id }, { $inc: { wallet: money(margin + feeRecovery - fee) } }, { session });
        const rows = [
          { amount: margin, type: margin >= 0 ? "commission" : "fee", description: "Platform checker margin", suffix: "platform" },
          { amount: feeRecovery, type: "fee", description: "Checker payment fee recovered", suffix: "fee-recovery" },
          { amount: -fee, type: "fee", description: "Checker payment gateway fee", suffix: "gateway-fee" },
        ].filter((row) => row.amount !== 0).map((row) => ({ agentId: admin._id, agent: admin.name, type: row.type, amount: row.amount, description: row.description, reference: `${purchase.reference}-${row.suffix}` }));
        if (rows.length) await Transaction.create(rows, { session, ordered: true });
        purchase.status = "completed";
        purchase.message = "Your result checker PINs are ready.";
        payment.status = "fulfilled";
        await payment.save({ session });
      }
    } else if (failed) {
      const buyer = await Agent.findByIdAndUpdate(purchase.agent, { $inc: { wallet: purchase.amount } }, { new: true, session });
      if (!buyer) throw new Error("Checker buyer no longer exists.");
      await Transaction.create([{
        agentId: buyer._id, agent: buyer.name, type: "refund", amount: purchase.amount,
        description: `${purchase.type.toUpperCase()} checker purchase refunded`, reference: `${purchase.reference}-refund`,
      }], { session, ordered: true });
      purchase.status = "refunded";
      purchase.message = "Purchase failed. The full amount was returned to your wallet.";
    } else {
      const margin = purchase.isSuperadmin ? 0 : money(purchase.amount - purchase.providerCost);
      if (margin !== 0) {
        const admin = await Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 }).session(session);
        if (!admin) throw new Error("Superadmin account is required to settle checker earnings.");
        await Agent.updateOne({ _id: admin._id }, { $inc: { wallet: margin } }, { session });
        await Transaction.create([{
          agentId: admin._id, agent: admin.name, type: margin > 0 ? "commission" : "fee", amount: margin,
          description: `Platform margin · ${purchase.type.toUpperCase()} checker × ${purchase.quantity}`,
          reference: `${purchase.reference}-platform`,
        }], { session, ordered: true });
      }
      purchase.status = "completed";
      purchase.message = "Your result checker PINs are ready.";
    }
    purchase.settledAt = new Date();
    await purchase.save({ session });
    return purchase;
  });
}

/** A public purchase is refunded through Paystack, never into the seller's wallet. */
export async function refundPublicCheckerPurchase(purchase) {
  if (purchase?.channel !== "public" || purchase.status !== "refund_pending") return;
  const payment = await Payment.findOne({ reference: purchase.paymentReference });
  if (!payment) return;
  if (!["refund_pending", "refund_failed", "refunded"].includes(payment.status)) {
    await requestPaystackRefundForPayment(payment, "Result checker PINs could not be delivered.");
  }
  const current = await Payment.findById(payment._id);
  if (current?.status === "refunded") {
    await CheckerPurchase.updateOne({ _id: purchase._id }, { $set: { status: "refunded", message: "Your payment has been refunded." } });
  }
}

/** Recover uncertain requests by lookup, then retry only with the original idempotency key. */
export async function syncCheckerPurchase(id) {
  const token = randomUUID();
  const now = new Date();
  const purchase = await CheckerPurchase.findOneAndUpdate({
    _id: id, status: { $in: openStatuses }, nextSyncAt: { $lte: now },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
  }, { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 120000) } }, { new: true }).select("+pins");
  if (!purchase) return;
  try {
    if (completeCheckerPins(purchase) || ["failed", "refunded"].includes(purchase.providerStatus)) {
      await settleCheckerPurchase(id);
      return;
    }
    if (!netpluseConfigured()) return;
    let result;
    let posted = false;
    if (purchase.dispatchedAt) {
      result = await netpluseCheckerPurchase(purchase.providerReference || purchase.reference);
      // Never re-purchase a known provider order or one that has returned any PINs.
      if (result.status === 404 && !purchase.providerReference && !purchase.pins.length) {
        posted = true;
        result = await netplusePurchaseCheckers(purchase);
      }
    } else {
      await CheckerPurchase.updateOne({ _id: id, leaseToken: token }, { $set: { dispatchedAt: new Date(), status: "processing" } });
      posted = true;
      result = await netplusePurchaseCheckers(purchase);
    }
    const parsed = checkerResponse(result.json, purchase);
    if (parsed.valid && (result.ok || parsed.pins.length)) {
      const update = { status: "processing", providerStatus: parsed.status };
      if (parsed.reference) update.providerReference = parsed.reference;
      if (parsed.providerCost !== undefined) update.providerCost = parsed.providerCost;
      // Never replace already-saved pins with an empty response.
      if (parsed.pins.length) {
        const pins = new Map((purchase.pins || []).map((pin) => [`${pin.serial}:${pin.pin}`, { serial: pin.serial, pin: pin.pin, expires: pin.expires }]));
        for (const pin of parsed.pins) pins.set(`${pin.serial}:${pin.pin}`, pin);
        update.pins = [...pins.values()];
      }
      await CheckerPurchase.updateOne({ _id: id, leaseToken: token }, { $set: update });
      if (!parsed.pins.length && !["failed", "refunded"].includes(parsed.status)) {
        const statusResult = await netpluseCheckerOrderStatus(parsed.reference || purchase.providerReference || purchase.reference);
        const status = checkerResponse(statusResult.json, purchase);
        if (statusResult.ok && status.valid && ["failed", "refunded"].includes(status.status)) {
          await CheckerPurchase.updateOne({ _id: id, leaseToken: token }, { $set: { providerStatus: status.status } });
        }
      }
      await settleCheckerPurchase(id);
    } else if (posted && parsed.valid && !parsed.pins.length && [400, 401, 402, 403, 422].includes(result.status) && !result.transportError) {
      await CheckerPurchase.updateOne({ _id: id, leaseToken: token }, { $set: { providerStatus: "failed" } });
      await settleCheckerPurchase(id);
    }
  } finally {
    await CheckerPurchase.updateOne({ _id: id, leaseToken: token }, {
      $set: { leaseUntil: null, leaseToken: "", nextSyncAt: new Date(Date.now() + 4000) },
    });
  }
}

export async function syncPendingCheckerPurchases({ limit = 10 } = {}) {
  const rows = await CheckerPurchase.find({ status: { $in: openStatuses }, nextSyncAt: { $lte: new Date() } }).sort({ nextSyncAt: 1 }).limit(limit);
  for (const row of rows) {
    try { await syncCheckerPurchase(row._id); }
    catch { console.error("Checker recovery needs another attempt:", row.reference); }
  }
  const refunds = await CheckerPurchase.find({ channel: "public", status: "refund_pending" }).sort({ updatedAt: 1 }).limit(limit);
  for (const purchase of refunds) await refundPublicCheckerPurchase(purchase);
  return { checked: rows.length };
}

export function publicCheckerPurchase(purchase, includePins = false) {
  return {
    reference: purchase.reference, clientReference: purchase.clientReference,
    type: purchase.type, quantity: purchase.quantity, unitPrice: purchase.unitPrice, amount: purchase.amount,
    status: purchase.status, message: purchase.message, createdAt: purchase.createdAt,
    ...(includePins ? { pins: purchase.pins || [] } : {}),
  };
}
