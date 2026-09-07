import test from "node:test";
import assert from "node:assert/strict";
import { priceChangeMessage, notifyPriceChange } from "../src/lib/priceNotifications.js";
import { Agent } from "../src/models/Agent.js";
import { Notification } from "../src/models/Notification.js";

test("price changes show old and new GHS amounts for increases and decreases", () => {
  assert.equal(priceChangeMessage("MTN 1 GB agent price", 5, 6.25), "The superadmin changed MTN 1 GB agent price from GHS 5.00 to GHS 6.25.");
  assert.match(priceChangeMessage("WAEC Result Checker price", 20, 15), /20.00 to GHS 15.00/);
});

test("unchanged, sub-pesewa and invalid changes do not notify", () => {
  for (const [before, after] of [[5, 5], [5, 5.001], [NaN, 5], [5, Infinity]]) {
    assert.equal(priceChangeMessage("bundle", before, after), null);
  }
});

test("notification fanout excludes superadmins and uses the price transaction", async (t) => {
  const session = {};
  const inserted = [];
  t.mock.method(Agent, "find", (filter) => {
    assert.deepEqual(filter, { role: { $ne: "superadmin" } });
    return { select: () => ({ session: (value) => {
      assert.equal(value, session);
      return { cursor: async function* () { yield { _id: "agent1" }; yield { _id: "agent2" }; } };
    } }) };
  });
  t.mock.method(Notification, "insertMany", async (rows, options) => {
    assert.equal(options.session, session);
    inserted.push(...rows);
  });
  await notifyPriceChange("MTN", 5, 6, session);
  assert.deepEqual(inserted.map((item) => item.agent), ["agent1", "agent2"]);
  await notifyPriceChange("MTN", 6, 6, session);
  assert.equal(inserted.length, 2);
});
