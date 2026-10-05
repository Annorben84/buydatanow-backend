import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.PAYSTACK_MODE = "test";
process.env.PAYSTACK_SECRET_KEY_TEST = "sk_test_wallet_recovery";
process.env.JWT_SECRET = "wallet-recovery-test-only";
const { Agent, Payment, Transaction, Log } = await import("../src/models/index.js");
const { verifyWalletTopup, pendingWalletTopups, syncPendingWalletTopups } = await import("../src/lib/walletTopupRecovery.js");
const { settleVerifiedPayment } = await import("../src/lib/paymentSettlement.js");
const { default: router } = await import("../src/paystackRoutes.js");

function query(value) {
  const result = Promise.resolve(value);
  for (const method of ["select", "session", "sort", "lean", "limit"]) result[method] = () => query(value);
  return result;
}

function fixture(t) {
  const state = {
    payment: {
      _id: "payment1", reference: "DP-wallet-recovery", purpose: "wallet_topup",
      provider: "paystack", status: "initialized", agent: "agent1", currency: "GHS",
      amount: 15, chargedAmount: 15.3, customerFee: 0.3, gatewayFee: 0,
      gatewayStatus: "", save: async () => {},
    },
    agent: { _id: "agent1", name: "Agent", wallet: 2.57 },
    admin: { _id: "admin1", name: "Admin", wallet: 10 },
    gateway: {
      reference: "DP-wallet-recovery", status: "success", id: "gateway1", fees: 30,
      amount: 1530, currency: "GHS", channel: "mobile_money",
      metadata: { purpose: "wallet_topup", agentId: "agent1" },
    },
    ledger: [], logs: [], requests: 0,
  };
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Payment, "findOne", (filter) => query(filter.reference === state.payment.reference ? state.payment : null));
  t.mock.method(Payment, "findById", () => query(state.payment));
  t.mock.method(Payment, "findOneAndUpdate", (_filter, update, options) => {
    assert.equal(options.session, session);
    Object.assign(state.payment, update.$set);
    return query(state.payment);
  });
  t.mock.method(Payment, "updateOne", async (filter, update) => {
    if (filter.status?.$in && !filter.status.$in.includes(state.payment.status)) return { matchedCount: 0 };
    Object.assign(state.payment, update.$set);
    return { matchedCount: 1 };
  });
  t.mock.method(Agent, "findById", () => query(state.agent));
  t.mock.method(Agent, "findByIdAndUpdate", async (_id, update, options) => {
    assert.equal(options.session, session);
    state.agent.wallet += update.$inc.wallet;
    return state.agent;
  });
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (_filter, update, options) => {
    assert.equal(options.session, session);
    state.admin.wallet += update.$inc.wallet;
  });
  t.mock.method(Transaction, "create", async (rows, options) => {
    assert.equal(options.session, session);
    for (const row of rows) {
      assert.ok(!state.ledger.some((existing) => existing.reference === row.reference));
      state.ledger.push(row);
    }
  });
  t.mock.method(Transaction, "findOne", (filter) => query(state.ledger.find((row) => row.reference === filter.reference)));
  t.mock.method(Log, "create", async (row) => { state.logs.push(row); return row; });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(url.endsWith(`/transaction/verify/${state.payment.reference}`));
    state.requests++;
    return { ok: true, json: async () => ({ status: true, data: structuredClone(state.gateway) }) };
  });
  return state;
}

test("recovers the GHS 15 principal exactly once and accounts separately for the GHS 0.30 fee", async (t) => {
  const state = fixture(t);
  const first = await verifyWalletTopup(state.payment.reference, { agentId: "agent1" });
  const second = await verifyWalletTopup(state.payment.reference, { agentId: "agent1" });
  assert.equal(first.status, "success");
  assert.equal(second.alreadySettled, true);
  assert.equal(state.requests, 1, "saved success must work without another Paystack request");
  assert.equal(Math.round(state.agent.wallet * 100), 1757);
  assert.equal(state.admin.wallet, 10, "customer fee recovery offsets the gateway fee");
  assert.deepEqual(state.ledger.map((row) => row.amount), [15, 0.3, -0.3]);
  assert.equal(state.ledger.filter((row) => row.type === "topup").length, 1);
  assert.equal(state.payment.status, "succeeded");
  assert.equal(state.logs[0].meta.reference, state.payment.reference);
});

test("pending and failed gateway responses never credit the wallet; later success can recover", async (t) => {
  const state = fixture(t);
  for (const status of ["pending", "failed"]) {
    state.gateway.status = status;
    assert.equal((await verifyWalletTopup(state.payment.reference)).status, status);
    assert.equal(state.payment.status, "initialized");
    assert.equal(state.payment.gatewayStatus, status);
    assert.equal(state.agent.wallet, 2.57);
    assert.equal(state.ledger.length, 0);
  }
  state.gateway.status = "success";
  assert.equal((await verifyWalletTopup(state.payment.reference)).status, "success");
  assert.equal(Math.round(state.agent.wallet * 100), 1757);
});

test("temporary verification failures leave the deposit available for retry", async (t) => {
  const state = fixture(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Temporary gateway outage"); });
  await assert.rejects(() => verifyWalletTopup(state.payment.reference), /Temporary gateway outage/);
  assert.equal(state.payment.status, "initialized");
  assert.ok(state.payment.lastVerifiedAt instanceof Date);
  assert.equal(state.agent.wallet, 2.57);
  assert.equal(state.ledger.length, 0);
  fetchMock.mock.restore();
  assert.equal((await verifyWalletTopup(state.payment.reference)).status, "success");
});

test("unknown or another account's references cannot reach Paystack or the wallet", async (t) => {
  const state = fixture(t);
  await assert.rejects(() => verifyWalletTopup(state.payment.reference, { agentId: "other-agent" }), (error) => error.status === 403);
  await assert.rejects(() => verifyWalletTopup("DP-unknown", { agentId: "agent1" }), (error) => error.status === 404);
  assert.equal(state.requests, 0);
  assert.equal(state.ledger.length, 0);
});

test("a delayed pending response cannot overwrite a concurrent webhook credit", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    await settleVerifiedPayment(state.payment.reference, state.gateway);
    return { ok: true, json: async () => ({ status: true, data: { status: "pending" } }) };
  });
  const result = await verifyWalletTopup(state.payment.reference);
  assert.equal(result.status, "success");
  assert.equal(result.alreadySettled, true);
  assert.equal(state.payment.gatewayStatus, "success");
  assert.equal(Math.round(state.agent.wallet * 100), 1757);
  assert.equal(state.ledger.filter((row) => row.type === "topup").length, 1);
});

test("pending discovery scopes to the owner and rotates older verification attempts", async (t) => {
  t.mock.method(Payment, "find", (filter) => {
    assert.equal(filter.agent, "agent1");
    assert.equal(filter.provider, "paystack");
    assert.equal(filter.purpose, "wallet_topup");
    assert.deepEqual(filter.status.$in, ["initialized", "processing"]);
    assert.equal(filter.$or[0].lastVerifiedAt, null);
    assert.ok(filter.$or[1].lastVerifiedAt.$lte instanceof Date);
    return { sort: (sort) => {
      assert.deepEqual(sort, { lastVerifiedAt: 1, createdAt: 1 });
      return { limit: (limit) => { assert.equal(limit, 5); return query([]); } };
    } };
  });
  assert.deepEqual(await pendingWalletTopups({ agentId: "agent1", limit: 5, retryAfterMs: 90_000 }), []);
});

test("one broken reference cannot stop recovery of another paid deposit", async (t) => {
  const state = fixture(t);
  t.mock.method(Payment, "find", () => query([{ reference: "DP-unknown" }, { reference: state.payment.reference }]));
  assert.deepEqual(await syncPendingWalletTopups(), { checked: 2, credited: 1, errors: 1 });
  assert.equal(Math.round(state.agent.wallet * 100), 1757);
  assert.ok(state.logs.some((log) => log.meta.reference === "DP-unknown"));
});

test("wallet checkout embeds its recovery reference in a normalized return URL", async (t) => {
  const oldOrigin = process.env.CLIENT_URL;
  process.env.CLIENT_URL = "https://example.test/";
  t.after(() => { if (oldOrigin === undefined) delete process.env.CLIENT_URL; else process.env.CLIENT_URL = oldOrigin; });
  t.mock.method(Payment, "create", async (data) => ({ _id: "payment1", ...data }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.amount, 1530);
    assert.equal(body.callback_url, `https://example.test/agent/add-fund?payment_reference=${body.reference}`);
    return { ok: true, json: async () => ({ status: true, data: { authorization_url: "https://checkout.paystack.com/test" } }) };
  });
  const handle = router.stack.find((layer) => layer.route?.path === "/init").route.stack[0].handle;
  const res = { json: (body) => { assert.equal(body.data.amount, 15); } };
  await handle({ agent: { _id: "agent1", email: "agent@example.test", role: "agent" }, body: { amount: 15 } }, res, (error) => { throw error; });
});
