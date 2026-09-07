import { Bundle } from "../models/Bundle.js";
import { withMongoTransaction } from "./mongoTransaction.js";
import { notifyPriceChange } from "./priceNotifications.js";

/** Preserve the existing GHS margin on increases; decreases leave agent prices alone. */
export function providerCostChange(bundle, nextCost) {
  const before = Math.round(Number(bundle.cost || 0) * 100);
  const after = Math.round(Number(nextCost) * 100);
  const price = Math.round(Number(bundle.price) * 100);
  if (![before, after, price].every(Number.isFinite) || after < 0) {
    throw new Error("Cannot sync an invalid bundle cost or agent price.");
  }
  if (before === after) return null;
  return {
    carrier: bundle.carrier,
    gb: bundle.gb,
    from: before / 100,
    to: after / 100,
    priceFrom: price / 100,
    priceTo: (price + Math.max(0, after - before)) / 100,
  };
}

/** Read inside the transaction so simultaneous refreshes cannot raise a price twice. */
export async function syncBundleCost(id, nextCost) {
  return withMongoTransaction(async (session) => {
    const bundle = await Bundle.findById(id).session(session);
    if (!bundle) return null;
    const change = providerCostChange(bundle, nextCost);
    if (!change) return null;
    bundle.cost = change.to;
    bundle.price = change.priceTo;
    await bundle.save({ session });
    await notifyPriceChange(`${bundle.carrier} ${bundle.gb} GB agent price`, change.priceFrom, change.priceTo, session);
    return change;
  });
}
