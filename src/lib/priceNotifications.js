import { Agent } from "../models/Agent.js";
import { Notification } from "../models/Notification.js";

export function priceChangeMessage(label, previous, current) {
  const before = Math.round(previous * 100);
  const after = Math.round(current * 100);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  return `The superadmin changed ${label} from GHS ${(before / 100).toFixed(2)} to GHS ${(after / 100).toFixed(2)}.`;
}

/** Called in the same transaction as the price update, including offline agents. */
export async function notifyPriceChange(label, previous, current, session) {
  const message = priceChangeMessage(label, previous, current);
  if (!message) return;
  const agents = Agent.find({ role: { $ne: "superadmin" } }).select("_id").session(session).cursor();
  let batch = [];
  for await (const agent of agents) {
    batch.push({ agent: agent._id, title: "Price updated", message });
    if (batch.length === 500) {
      await Notification.insertMany(batch, { session });
      batch = [];
    }
  }
  if (batch.length) await Notification.insertMany(batch, { session });
}
