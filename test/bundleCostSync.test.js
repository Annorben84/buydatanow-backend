import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Bundle } from "../src/models/Bundle.js";
import { Agent } from "../src/models/Agent.js";
import { Notification } from "../src/models/Notification.js";
import { providerCostChange, syncBundleCost } from "../src/lib/bundleCostSync.js";

test("cost increases preserve the fixed cedi margin, rounded to pesewas", () => {
  const change = providerCostChange({ carrier: "MTN", gb: 1, cost: 4.4, price: 4.7 }, 5.1);
  assert.deepEqual(change, { carrier: "MTN", gb: 1, from: 4.4, to: 5.1, priceFrom: 4.7, priceTo: 5.4 });
  assert.equal(providerCostChange({ cost: 4.4, price: 4.7 }, 4.401), null);
});

test("cost decreases update only cost and previews do not mutate bundles", () => {
  const bundle = { cost: 5, price: 7 };
  const change = providerCostChange(bundle, 4);
  assert.equal(change.to, 4);
  assert.equal(change.priceTo, 7);
  assert.deepEqual(bundle, { cost: 5, price: 7 });
  assert.throws(() => providerCostChange(bundle, NaN), /invalid/);
});

test("cost sync saves price and notification together; repeated refreshes do not duplicate increases", async (t) => {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  let saves = 0;
  const bundle = { carrier: "MTN", gb: 1, cost: 4, price: 6, save: async (options) => {
    assert.equal(options.session, session);
    saves++;
  } };
  t.mock.method(Bundle, "findById", () => ({ session: async (value) => {
    assert.equal(value, session);
    return bundle;
  } }));
  t.mock.method(Agent, "find", () => ({ select: () => ({ session: () => ({ cursor: async function* () { yield { _id: "agent1" }; } }) }) }));
  const notifications = [];
  t.mock.method(Notification, "insertMany", async (rows, options) => {
    assert.equal(options.session, session);
    notifications.push(...rows);
  });
  await syncBundleCost("bundle1", 5);
  assert.equal(bundle.cost, 5);
  assert.equal(bundle.price, 7);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /6.00 to GHS 7.00/);
  assert.equal(await syncBundleCost("bundle1", 5), null);
  assert.equal(saves, 1);
  await syncBundleCost("bundle1", 4.5);
  assert.equal(bundle.price, 7);
  assert.equal(notifications.length, 1);
  // A manually changed margin is the one preserved on the next cost increase.
  bundle.price = 8;
  await syncBundleCost("bundle1", 5);
  assert.equal(bundle.price, 8.5);
  assert.equal(notifications.length, 2);
});
