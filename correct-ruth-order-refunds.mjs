import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { connectDB } from "./src/config/db.js";
import { withMongoTransaction } from "./src/lib/mongoTransaction.js";
import { netpluseOrderStatus, capacityInGb } from "./src/lib/netpluseApi.js";

// Narrowly scoped to the two wallet refunds explicitly approved on 2026-10-17.
const refs = [
  "DP-d6374323-9598-42e3-a7b7-cb06ea0ee483",
  "DP-7759a363-5407-4e1a-9b12-f45ddad1b83c",
];
const buyerId = "6a92d165ace39fa249ada323";
const correctionId = "refund-correction-20261017";
const cents = (value) => Math.round(Number(value) * 100);
const sameId = (a, b) => String(a) === String(b);
const correctionRef = (ref, side) => `${ref}-${correctionId}-${side}`;
const requireState = (condition, message) => { if (!condition) throw new Error(message); };

export async function correctRefunds(db, liveByRef, { apply = false, transact = withMongoTransaction } = {}) {
  const work = async (session) => {
    const options = session ? { session } : {};
    const orders = await db.collection("orders").find({ ref: { $in: refs } }, options).toArray();
    requireState(orders.length === 2, "Expected exactly the two approved orders.");
    const markers = await db.collection("transactions").find({
      reference: { $in: refs.map((ref) => correctionRef(ref, "agent")) },
    }, options).toArray();
    const buyer = await db.collection("agents").findOne({ _id: new mongoose.Types.ObjectId(buyerId) }, options);
    requireState(buyer, "Buyer account was not found.");
    if (markers.length === 2) {
      requireState(markers.every((row) => sameId(row.agentId, buyer._id) && cents(row.amount) === -4245), "Existing correction entries do not match approval.");
      return { alreadyApplied: true, wallet: buyer.wallet, orders: orders.map(({ ref, status }) => ({ ref, status })) };
    }
    requireState(markers.length === 0, "Partial correction markers found; manual review required.");
    requireState(cents(buyer.wallet) >= 8490, "Wallet balance is below the approved GHS 84.90 debit; no changes made.");
    const plans = [];
    for (const order of orders) {
      const live = liveByRef.get(order.ref);
      requireState(live?.ok && ["processing", "on_hold", "completed"].includes(live.status), `${order.ref}: provider has not confirmed an active or delivered order.`);
      requireState(live.providerRef === order.ref && live.network === order.carrier && capacityInGb(live.capacity) === order.gb, `${order.ref}: provider identity does not match.`);
      requireState(order.status === "refunded" && order.reversedAt && sameId(order.agent, buyer._id), `${order.ref}: order is no longer the approved refunded order.`);
      requireState(order.paymentProvider === "wallet" && !order.paymentReference && !order.store && !order.reversal?.storeId && !order.earningsSettledAt, `${order.ref}: unexpected accounting path.`);
      requireState(cents(order.amount) === 4245 && cents(order.platformEarning) === 124 && cents(order.reversal?.agentWalletAdjustment) === 4245 && cents(order.reversal?.platformWalletAdjustment) === -124, `${order.ref}: amounts differ from approval.`);
      const ledger = await db.collection("transactions").find({ reference: { $in: [
        `${order.ref}-purchase`, `${order.ref}-platform`, `${order.ref}-refund-agent`, `${order.ref}-refund-platform`,
      ] } }, options).toArray();
      const row = (suffix, amount, type) => {
        const matches = ledger.filter((entry) => entry.reference === `${order.ref}-${suffix}`);
        requireState(matches.length === 1 && cents(matches[0].amount) === amount && matches[0].type === type, `${order.ref}: invalid ${suffix} ledger entry.`);
        return matches[0];
      };
      const purchase = row("purchase", -4245, "purchase");
      const margin = row("platform", 124, "commission");
      const buyerRefund = row("refund-agent", 4245, "refund");
      const platformRefund = row("refund-platform", -124, "refund");
      requireState(sameId(purchase.agentId, buyer._id) && sameId(buyerRefund.agentId, buyer._id) && sameId(margin.agentId, platformRefund.agentId), `${order.ref}: ledger account mismatch.`);
      const platform = await db.collection("agents").findOne({ _id: platformRefund.agentId, role: "superadmin" }, options);
      requireState(platform, `${order.ref}: original platform account was not found.`);
      plans.push({ order, live, buyerRefund, platformRefund, platform });
    }
    const result = {
      applied: apply, buyerDebit: 84.90, platformCredit: 2.48,
      walletBefore: buyer.wallet, walletAfter: (cents(buyer.wallet) - 8490) / 100,
      orders: plans.map(({ order, live }) => ({ ref: order.ref, before: order.status, after: live.status, debit: 42.45 })),
    };
    if (!apply) return result;
    const now = new Date();
    const debited = await db.collection("agents").updateOne(
      { _id: buyer._id, wallet: { $gte: 84.90 } },
      { $inc: { wallet: -84.90 }, $set: { updatedAt: now } }, options,
    );
    requireState(debited.modifiedCount === 1, "Wallet debit could not be claimed.");
    for (const { order, live, buyerRefund, platformRefund, platform } of plans) {
      // Preserve refund rows and their signed amounts. Move their idempotency
      // references aside so a later genuine delivery failure can refund once.
      for (const refund of [buyerRefund, platformRefund]) {
        const archived = await db.collection("transactions").updateOne(
          { _id: refund._id, reference: refund.reference },
          { $set: { reference: `${refund.reference}-before-${correctionId}`, updatedAt: now } }, options,
        );
        requireState(archived.modifiedCount === 1, `${order.ref}: refund entry changed concurrently.`);
      }
      const credited = await db.collection("agents").updateOne(
        { _id: platform._id }, { $inc: { wallet: 1.24 }, $set: { updatedAt: now } }, options,
      );
      requireState(credited.modifiedCount === 1, "Could not restore the original platform margin.");
      await db.collection("transactions").insertMany([
        { agentId: buyer._id, agent: buyer.name, type: "purchase", amount: -42.45, reference: correctionRef(order.ref, "agent"), description: `Approved reversal of premature wallet refund · ${order.ref}`, store: "", createdAt: now, updatedAt: now },
        { agentId: platform._id, agent: platform.name, type: "commission", amount: 1.24, reference: correctionRef(order.ref, "platform"), description: `Platform margin restored after premature refund · ${order.ref}`, store: "", createdAt: now, updatedAt: now },
      ], options);
      const set = { status: live.status, provider: "netpluse", providerRef: live.providerRef, providerStatus: live.raw, providerMessage: live.message, updatedAt: now };
      if (live.status === "completed") set.deliveredAt = order.deliveredAt || now;
      const updated = await db.collection("orders").updateOne(
        { _id: order._id, status: "refunded", reversedAt: order.reversedAt },
        { $set: set, $unset: { reversedAt: "" } }, options,
      );
      requireState(updated.modifiedCount === 1, `${order.ref}: order changed concurrently.`);
      if (order.phone) await db.collection("customers").updateOne(
        { agent: buyer._id, phone: order.phone },
        { $inc: { orders: 1, spent: 42.45 }, $set: { updatedAt: now } }, options,
      );
      await db.collection("logs").insertOne({
        level: "warning", source: "orders/refund-correction",
        message: `Approved premature refund correction · ${order.ref} · GHS 42.45 wallet debit · ${live.status}`,
        meta: { correctionId, userApproved: true, buyerDebit: 42.45, platformCredit: 1.24, originalReversedAt: order.reversedAt, originalRefundReferences: [buyerRefund.reference, platformRefund.reference] },
        createdAt: now, updatedAt: now,
      }, options);
    }
    return result;
  };
  return apply ? transact(work) : work();
}

async function main() {
  const apply = process.argv.includes("--apply");
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  try {
    console.log(apply ? "Applying approved refund correction." : "Read-only preflight; no changes.");
    await connectDB(process.env.MONGODB_URI, { retries: 0 });
    const live = await Promise.all(refs.map(async (ref) => [ref, await netpluseOrderStatus(ref)]));
    const result = await correctRefunds(mongoose.connection.db, new Map(live), { apply });
    console.log(JSON.stringify(result, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); process.exit(0); }
  catch (error) { console.error(error.message); process.exit(1); }
}
