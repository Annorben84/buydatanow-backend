import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Agent, Order, Payment, Transaction } from "../src/models/index.js";
import { settleCompletedOrderEarnings } from "../src/lib/fulfilment.js";
import { bookAgentWalletStorefrontOrder } from "../src/lib/directPaymentSettlement.js";
import { settleVerifiedPayment } from "../src/lib/paymentSettlement.js";

const query = (value) => ({ session: async () => value });
function sessionMock(t) {
  t.mock.method(mongoose, "startSession", async () => ({
    withTransaction: async (work) => work(), endSession: async () => {},
  }));
}

test("delivered storefront sale credits only commission, even with an empty wallet, once", async (t) => {
  sessionMock(t);
  const agent = { _id: "agent", name: "Agent", wallet: 0, commissionAvailable: 0 };
  const order = {
    _id: "order", agent: "agent", ref: "sale", store: "Shop", status: "completed",
    settlementModel: "platform_collected", earning: 2.35, platformEarning: 0.65,
  };
  let claimed = false;
  t.mock.method(Order, "findOneAndUpdate", async () => {
    if (claimed) return null;
    claimed = true;
    return order;
  });
  t.mock.method(Agent, "findById", () => query(agent));
  t.mock.method(Agent, "findOne", () => ({ sort: () => query(null) }));
  const writes = [];
  t.mock.method(Agent, "updateOne", async (_filter, update) => {
    writes.push(update);
    agent.commissionAvailable += update.$inc.commissionAvailable;
  });
  t.mock.method(Transaction, "create", async (rows) => {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "commission");
    assert.equal(rows[0].amount, 2.35);
  });
  assert.equal(await settleCompletedOrderEarnings(order), true);
  assert.equal(await settleCompletedOrderEarnings(order), false);
  assert.deepEqual(writes, [{ $inc: { commissionAvailable: 2.35 } }]);
  assert.equal(agent.wallet, 0);
  assert.equal(agent.commissionAvailable, 2.35);
});

test("undelivered storefront orders earn no commission", async () => {
  for (const status of ["pending", "processing", "failed", "refunded"]) {
    assert.equal(await settleCompletedOrderEarnings({ status, settlementModel: "platform_collected" }), false);
  }
});

test("legacy manual storefront fulfilment cannot debit an agent", async () => {
  await assert.rejects(bookAgentWalletStorefrontOrder(), { status: 410 });
});

test("legacy gateway checkouts are held for review without a wallet debit", async (t) => {
  sessionMock(t);
  t.mock.method(Payment, "findOne", () => query({
    status: "initialized", purpose: "storefront_order", provider: "paystack",
    settlementModel: "agent_wallet_debit", paymentDestination: "agent",
  }));
  const writes = t.mock.method(Agent, "findOneAndUpdate", async () => {
    throw new Error("Must not debit the agent");
  });
  await assert.rejects(settleVerifiedPayment("legacy", { status: "success" }), { status: 409 });
  assert.equal(writes.mock.callCount(), 0);
});
