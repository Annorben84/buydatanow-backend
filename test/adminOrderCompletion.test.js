import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";

process.env.JWT_SECRET = "admin-order-completion-test-only";
const { Agent, Order, Payment, Transaction, Log } = await import("../src/models/index.js");
const { completeOrderManually, settleCompletedOrderEarnings } = await import("../src/lib/fulfilment.js");
const { signToken } = await import("../src/lib/auth.js");
const { default: router } = await import("../src/adminRoutes.js");

function query(value) {
  const result = Promise.resolve(value);
  for (const method of ["session", "sort"]) result[method] = () => query(value);
  return result;
}

function fixture(t, status = "processing") {
  const state = {
    order: {
      _id: "order", ref: "DP-manual", agent: "agent", status, store: "Agent Shop",
      earning: 2.35, platformEarning: 0.65, paymentReference: "PAY-manual",
      settlementModel: "platform_collected", provider: "netpluse", providerRef: "NP-manual",
      providerStatus: "on-hold", carrier: "MTN", gb: 1,
    },
    agent: { _id: "agent", name: "Agent", role: "agent", status: "active", wallet: 0, commissionAvailable: 0 },
    admin: { _id: "admin", name: "Admin", role: "superadmin", status: "active", wallet: 0 },
    payment: { status: "fulfilling", amount: 5, chargedAmount: 5, gatewayFee: 0 },
    ledger: [], logs: [], reads: 0,
  };
  const session = {
    async withTransaction(work) {
      const snapshot = structuredClone(state);
      try { await work(); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
    async endSession() {},
  };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Order, "findOne", ({ ref }) => {
    state.reads++;
    return query(ref === state.order.ref ? { ...state.order } : null);
  });
  t.mock.method(Order, "findOneAndUpdate", (filter, update, options) => {
    assert.equal(options.session, session);
    if (filter.status !== state.order.status || state.order.reversedAt) return query(null);
    if (filter.earningsSettledAt === null && state.order.earningsSettledAt) return query(null);
    Object.assign(state.order, update.$set);
    return query({ ...state.order });
  });
  t.mock.method(Agent, "findById", (id) => query(id === "admin" ? state.admin : state.agent));
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, session);
    const account = filter._id === "admin" ? state.admin : state.agent;
    for (const [key, amount] of Object.entries(update.$inc)) account[key] += amount;
  });
  t.mock.method(Payment, "findOne", () => query(state.payment));
  t.mock.method(Payment, "updateOne", async (_filter, update, options) => {
    assert.equal(options.session, session);
    Object.assign(state.payment, update.$set);
  });
  t.mock.method(Transaction, "create", async (rows, options) => {
    assert.equal(options.session, session);
    state.ledger.push(...rows);
  });
  t.mock.method(Log, "create", async (row) => { state.logs.push(row); });
  return state;
}

test("manual completion releases the saved commission and platform margin exactly once", async (t) => {
  for (const status of ["pending", "processing", "on_hold"]) {
    await t.test(status, async (t) => {
      const state = fixture(t, status);
      const first = await completeOrderManually(state.order.ref, "admin");
      const deliveredAt = state.order.deliveredAt;
      const retry = await completeOrderManually(state.order.ref, "another-admin");
      assert.equal(first.alreadyCompleted, false);
      assert.equal(first.earningsSettled, true);
      assert.equal(retry.alreadyCompleted, true);
      assert.equal(retry.earningsSettled, false);
      assert.equal(state.order.status, "completed");
      assert.equal(state.order.deliveredAt, deliveredAt);
      assert.ok(state.order.manuallyCompletedAt instanceof Date);
      assert.equal(state.order.manuallyCompletedBy, "admin");
      assert.equal(state.order.providerRef, "NP-manual");
      assert.equal(state.order.providerStatus, "on-hold");
      assert.equal(state.agent.commissionAvailable, 2.35);
      assert.equal(state.agent.wallet, 0);
      assert.equal(state.admin.wallet, 0.65);
      assert.equal(state.payment.status, "fulfilled");
      assert.deepEqual(state.ledger.map((row) => row.reference), ["DP-manual-margin", "DP-manual-platform"]);
      assert.equal(await settleCompletedOrderEarnings(state.order), false, "later provider settlement cannot double-credit");
    });
  }
});

test("portal orders complete without inventing an agent commission", async (t) => {
  const state = fixture(t);
  state.order.earning = 0;
  await completeOrderManually(state.order.ref, "admin");
  assert.equal(state.order.status, "completed");
  assert.equal(state.agent.commissionAvailable, 0);
  assert.deepEqual(state.ledger.map((row) => row.reference), ["DP-manual-platform"]);
});

test("completed orders with unsettled earnings can be safely recovered", async (t) => {
  const state = fixture(t, "completed");
  const result = await completeOrderManually(state.order.ref, "admin");
  assert.equal(result.alreadyCompleted, true);
  assert.equal(result.earningsSettled, true);
  assert.equal(state.agent.commissionAvailable, 2.35);
});

test("failed, cancelled, refunded, reversed, and refunding orders cannot release commission", async (t) => {
  const cases = [
    { status: "failed" }, { status: "cancelled" }, { status: "refunded" },
    { reversedAt: new Date() }, { refund: { status: "pending" } },
  ];
  for (const fields of cases) {
    await t.test(JSON.stringify(fields), async (t) => {
      const state = fixture(t);
      Object.assign(state.order, fields);
      await assert.rejects(completeOrderManually(state.order.ref, "admin"), { status: 409 });
      assert.equal(state.agent.commissionAvailable, 0);
      assert.deepEqual(state.ledger, []);
    });
  }
});

test("unconfirmed and refunding payments cannot be completed", async (t) => {
  for (const status of ["initialized", "processing", "failed", "refund_pending", "refund_failed", "refunded"]) {
    await t.test(status, async (t) => {
      const state = fixture(t);
      state.payment.status = status;
      await assert.rejects(completeOrderManually(state.order.ref, "admin"), { status: 409 });
      assert.equal(state.order.status, "processing");
      assert.equal(state.agent.commissionAvailable, 0);
    });
  }
});

test("settlement failures roll back completion, balances, and the earnings claim", async (t) => {
  const state = fixture(t);
  t.mock.method(Transaction, "create", async () => { throw new Error("Ledger unavailable"); });
  await assert.rejects(completeOrderManually(state.order.ref, "admin"), /Ledger unavailable/);
  assert.equal(state.order.status, "processing");
  assert.equal(state.order.deliveredAt, undefined);
  assert.equal(state.order.earningsSettledAt, undefined);
  assert.equal(state.order.manuallyCompletedBy, undefined);
  assert.equal(state.agent.commissionAvailable, 0);
  assert.equal(state.admin.wallet, 0);
  assert.equal(state.payment.status, "fulfilling");
});

test("a lost order claim cannot release commission", async (t) => {
  const state = fixture(t);
  t.mock.method(Order, "findOneAndUpdate", () => query(null));
  await assert.rejects(completeOrderManually(state.order.ref, "admin"), { status: 409 });
  assert.equal(state.agent.commissionAvailable, 0);
  assert.deepEqual(state.ledger, []);
});

test("only superadmin can use the completion API and successful changes are audited", async (t) => {
  const state = fixture(t);
  const app = express();
  app.use("/api/admin", router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function post(account, ref = state.order.ref) {
    return fetch(`http://127.0.0.1:${server.address().port}/api/admin/orders/${ref}/complete`, {
      method: "POST", headers: account ? { Authorization: `Bearer ${signToken(account)}` } : {},
    });
  }
  assert.equal((await post(null)).status, 401);
  assert.equal((await post("agent")).status, 403);
  assert.equal(state.reads, 0);
  assert.equal((await post("admin", "missing")).status, 404);
  const response = await post("admin");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "completed");
  assert.equal(state.logs[0].meta.adminId, "admin");
  assert.equal(state.logs[0].meta.ref, state.order.ref);
});
