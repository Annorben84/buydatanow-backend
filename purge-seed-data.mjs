// One-off cleanup (2026-07-21, run at the owner's request): remove SEED demo
// agents — accounts with no password hash, which can never log in — and all
// data owned by them (stores, orders, customers, transactions, withdrawals,
// agent prices). Real accounts (password-holders + superadmin) are untouched.
import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "./src/config/db.js";
import {
  Agent,
  Store,
  Order,
  Customer,
  Transaction,
  Withdrawal,
  AgentPrice,
} from "./src/models/index.js";

await connectDB(process.env.MONGODB_URI);

const candidates = await Agent.find({ role: { $ne: "superadmin" } })
  .select("+passwordHash")
  .lean();
const seedAgents = candidates.filter((a) => !a.passwordHash);
const ids = seedAgents.map((a) => a._id);
console.log("Purging seed agents:", seedAgents.map((a) => a.name).join(", ") || "(none)");

const [st, or_, cu, tx, wd, ap, ag] = await Promise.all([
  Store.deleteMany({ agent: { $in: ids } }),
  Order.deleteMany({ agent: { $in: ids } }),
  Customer.deleteMany({ agent: { $in: ids } }),
  Transaction.deleteMany({ agentId: { $in: ids } }),
  Withdrawal.deleteMany({ agent: { $in: ids } }),
  AgentPrice.deleteMany({ agent: { $in: ids } }),
  Agent.deleteMany({ _id: { $in: ids } }),
]);
console.log(
  `deleted -> stores:${st.deletedCount} orders:${or_.deletedCount} customers:${cu.deletedCount}`,
  `txns:${tx.deletedCount} withdrawals:${wd.deletedCount} prices:${ap.deletedCount} agents:${ag.deletedCount}`
);

// Orphan rows that never had an owner (from early pre-tenant testing).
const [o2, c2, t2] = await Promise.all([
  Order.deleteMany({ agent: { $exists: false } }),
  Customer.deleteMany({ agent: { $exists: false } }),
  Transaction.deleteMany({ agentId: { $exists: false } }),
]);
console.log(`orphans -> orders:${o2.deletedCount} customers:${c2.deletedCount} txns:${t2.deletedCount}`);

console.log(
  "REMAINING -> agents:",
  await Agent.countDocuments(),
  "| stores:",
  await Store.countDocuments(),
  "| orders:",
  await Order.countDocuments(),
  "| customers:",
  await Customer.countDocuments(),
  "| txns:",
  await Transaction.countDocuments()
);

await mongoose.disconnect();
