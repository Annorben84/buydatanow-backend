import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "./src/config/db.js";
import { Agent, Bundle, Order, Transaction } from "./src/models/index.js";
import { withMongoTransaction } from "./src/lib/mongoTransaction.js";
import { platformBundleMargin } from "./src/lib/pricingPolicy.js";

const activeOrder = { status: { $nin: ["failed", "refunded"] } };
const missingMargin = {
  $or: [
    { platformEarning: { $exists: false } },
    { platformEarning: { $lte: 0 } },
  ],
};

async function reconcilePlatformEarnings() {
  await connectDB(process.env.MONGODB_URI, { retries: 0 });

  const [superadmin, bundles, orders] = await Promise.all([
    Agent.findOne({ role: "superadmin" }).sort({ createdAt: 1 }).lean(),
    Bundle.find().select("carrier gb price cost").lean(),
    Order.find({
      ...activeOrder,
      ...missingMargin,
      store: { $in: ["", null] },
    })
      .select("ref carrier gb providerCost status")
      .lean(),
  ]);

  if (!superadmin) throw new Error("No Superadmin account exists.");

  const bundleByKey = new Map(
    bundles.map((bundle) => [`${bundle.carrier}:${bundle.gb}`, bundle])
  );
  const candidates = orders
    .map((order) => {
      const bundle = bundleByKey.get(`${order.carrier}:${order.gb}`);
      if (!bundle) return null;
      const providerCost = Number(order.providerCost) > 0
        ? Number(order.providerCost)
        : Number(bundle.cost);
      const margin = platformBundleMargin({
        platformPrice: bundle.price,
        providerCost,
      });
      return margin > 0 ? { order, margin } : null;
    })
    .filter(Boolean);

  const result = await withMongoTransaction(async (session) => {
    let credited = 0;
    let reconciled = 0;

    for (const candidate of candidates) {
      const order = await Order.findOne({
        _id: candidate.order._id,
        ...activeOrder,
        ...missingMargin,
      }).session(session);
      if (!order) continue;

      const reference = `${order.ref}-platform`;
      const existingLedgerRow = await Transaction.findOne({ reference }).session(session);

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            platformEarning: candidate.margin,
            "reversal.platformWalletAdjustment": -candidate.margin,
          },
        },
        { session }
      );
      reconciled += 1;

      if (existingLedgerRow) continue;

      await Agent.updateOne(
        { _id: superadmin._id },
        { $inc: { wallet: candidate.margin } },
        { session }
      );
      await Transaction.create(
        [
          {
            agentId: superadmin._id,
            agent: superadmin.name,
            type: "commission",
            description: `Platform margin · reconciled agent purchase · ${order.carrier} ${order.gb}GB`,
            amount: candidate.margin,
            reference,
          },
        ],
        { session, ordered: true }
      );
      credited += candidate.margin;
    }

    return { reconciled, credited: Math.round(credited * 100) / 100 };
  });

  console.log(JSON.stringify({ candidates: candidates.length, ...result }));
}

try {
  await reconcilePlatformEarnings();
} finally {
  await mongoose.disconnect();
}
