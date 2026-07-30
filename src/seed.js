import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "./config/db.js";
import { Agent, Store, Bundle, Order, Customer, Transaction } from "./models/index.js";

const agents = [
  { name: "Kwame Mensah", phone: "024 100 2010", wallet: 1240, revenue: 48210.5, tier: "Gold", status: "active" },
  { name: "Ama Serwaa", phone: "055 220 4411", wallet: 865.5, revenue: 31120, tier: "Gold", status: "active" },
  { name: "Kojo Boateng", phone: "020 771 8899", wallet: 132, revenue: 14900, tier: "Silver", status: "active" },
  { name: "Kofi Asante", phone: "027 110 4408", wallet: 3110, revenue: 62400, tier: "Gold", status: "active" },
];

const stores = [
  { name: "Ama Data Hub", slug: "ama-data-hub", phone: "024 100 2010", whatsapp: "024 100 2010", status: "active", orders: 128, revenue: 4820.5, customers: 64, balance: 1240, agentName: "Kwame Mensah" },
  { name: "QuickMB", slug: "quickmb", phone: "055 220 4411", whatsapp: "055 220 4411", status: "active", orders: 86, revenue: 3110, customers: 41, balance: 865.5, agentName: "Kwame Mensah" },
  { name: "Campus Bundles", slug: "campus-bundles", phone: "020 771 8899", whatsapp: "020 771 8899", status: "paused", orders: 52, revenue: 1490, customers: 28, balance: 132, agentName: "Kojo Boateng" },
];

const bundles = [
  { carrier: "MTN", size: "1 GB", gb: 1, cost: 3.8, price: 4.3, active: true },
  { carrier: "MTN", size: "5 GB", gb: 5, cost: 21.5, price: 24.5, active: true },
  { carrier: "MTN", size: "10 GB", gb: 10, cost: 37, price: 42, active: true },
  { carrier: "MTN", size: "20 GB", gb: 20, cost: 70, price: 78, active: true },
  { carrier: "Telecel", size: "5 GB", gb: 5, cost: 21, price: 24.5, active: true },
  { carrier: "Telecel", size: "10 GB", gb: 10, cost: 37, price: 42, active: true },
  { carrier: "AirtelTigo", size: "3 GB", gb: 3, cost: 12.5, price: 15, active: true },
  { carrier: "AirtelTigo", size: "10 GB", gb: 10, cost: 37, price: 42, active: true },
];

const customers = [
  { name: "Ama Mensah", phone: "024 418 2210", store: "Ama Data Hub", wallet: 12.5, orders: 8, spent: 210 },
  { name: "Efua Sarpong", phone: "020 771 5533", store: "Ama Data Hub", wallet: 0, orders: 5, spent: 168 },
  { name: "Kwesi Boateng", phone: "055 902 7741", store: "QuickMB", wallet: 3, orders: 3, spent: 62 },
  { name: "Adjoa Nyarko", phone: "059 233 8890", store: "Campus Bundles", wallet: 20, orders: 6, spent: 240 },
];

const orders = [
  { ref: "DP-10482", store: "Ama Data Hub", customer: "Ama Mensah", phone: "024 418 2210", carrier: "MTN", bundle: "5 GB", amount: 24.5, earning: 2.2, status: "pending" },
  { ref: "DP-10480", store: "Ama Data Hub", customer: "Efua Sarpong", phone: "020 771 5533", carrier: "AirtelTigo", bundle: "10 GB", amount: 42, earning: 3.8, status: "completed" },
  { ref: "DP-10478", store: "QuickMB", customer: "Adjoa Nyarko", phone: "059 233 8890", carrier: "MTN", bundle: "20 GB", amount: 78, earning: 6.9, status: "failed" },
];

const transactions = [
  { type: "purchase", description: "MTN 5GB · customer order", agent: "Kwame Mensah", amount: 24.5 },
  { type: "funding", description: "Wallet funding", agent: "Kojo Boateng", amount: 300 },
  { type: "payout", description: "Agent withdrawal", agent: "Kofi Asante", amount: -3110 },
  { type: "commission", description: "Platform commission", agent: "Ama Serwaa", amount: 6.9 },
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("✗ MONGODB_URI is not set. Add it to backend/.env first.");
    process.exit(1);
  }

  await connectDB(uri);
  console.log("✓ Connected. Clearing existing data…");
  await Promise.all([
    Agent.deleteMany({}),
    Store.deleteMany({}),
    Bundle.deleteMany({}),
    Order.deleteMany({}),
    Customer.deleteMany({}),
    Transaction.deleteMany({}),
  ]);

  const agentDocs = await Agent.insertMany(agents);
  const byName = Object.fromEntries(agentDocs.map((a) => [a.name, a._id]));
  // store name -> owning agent id, so orders/customers inherit the store's owner.
  const storeToAgent = Object.fromEntries(stores.map((s) => [s.name, byName[s.agentName]]));

  const storeDocs = await Store.insertMany(
    stores.map(({ agentName, ...s }) => ({ ...s, agent: byName[agentName] }))
  );
  const bundleDocs = await Bundle.insertMany(bundles);
  const customerDocs = await Customer.insertMany(
    customers.map((c) => ({ ...c, agent: storeToAgent[c.store] }))
  );
  const orderDocs = await Order.insertMany(
    orders.map((o) => ({ ...o, agent: storeToAgent[o.store] }))
  );
  const txDocs = await Transaction.insertMany(
    transactions.map((t) => ({ ...t, agentId: byName[t.agent] }))
  );

  console.log("✓ Seeded:");
  console.table({
    agents: agentDocs.length,
    stores: storeDocs.length,
    bundles: bundleDocs.length,
    customers: customerDocs.length,
    orders: orderDocs.length,
    transactions: txDocs.length,
  });

  await mongoose.disconnect();
  console.log("✓ Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("✗ Seed failed:", err.message);
  process.exit(1);
});
