import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.PAYSTACK_MODE = "test";
process.env.PAYSTACK_SECRET_KEY_TEST = "sk_test_admin_credit";
process.env.JWT_SECRET = "admin-credit-test-only";
const { Agent, Payment, Transaction, Log } = await import("../src/models/index.js");
const {
  creditAgentWallet,
  MAX_ADMIN_CREDIT_GHS,
  validateAdminCredit,
} = await import("../src/lib/adminCredit.js");
const { verifyWalletTopup, syncPendingWalletTopups } = await import("../src/lib/walletTopupRecovery.js");
const { settleVerifiedPayment } = await import("../src/lib/paymentSettlement.js");
const { default: router } = await import("../src/adminRoutes.js");

function query(value) {
  const result = Promise.resolve(value);
  for (const method of ["select", "session", "sort", "lean", "limit"]) {
    result[method] = () => query(value);
  }
  return result;
}

function fixture(t) {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  const state = {
    agent: { _id: "agent-1", name: "Ama Agent", role: "agent", wallet: 10 },
    admin: { _id: "admin-1", name: "Super Admin", role: "superadmin", wallet: 10 },
    payment: {
      _id: "payment-1", reference: "DP-admin-credit", purpose: "wallet_topup",
      provider: "paystack", status: "initialized", agent: "agent-1", currency: "GHS",
      amount: 25.5, chargedAmount: 26.01, customerFee: 0.51, gatewayFee: 0,
      gatewayStatus: "", save: async () => {},
    },
    gateway: {
      reference: "DP-admin-credit", status: "success", id: "gateway-1", fees: 51,
      amount: 2601, currency: "GHS", channel: "mobile_money",
      metadata: { purpose: "wallet_topup", agentId: "agent-1" },
    },
    ledger: [], logs: [], requests: 0,
  };

  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Agent, "findById", (id) => query(id === state.agent._id ? state.agent : null));
  t.mock.method(Agent, "findByIdAndUpdate", async (id, update, options) => {
    assert.equal(id, state.agent._id);
    assert.equal(options.session, session);
    state.agent.wallet += update.$inc.wallet;
    return state.agent;
  });
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (filter, update, options) => {
    assert.equal(filter._id, state.admin._id);
    assert.equal(options.session, session);
    state.admin.wallet += update.$inc.wallet;
  });
  t.mock.method(Payment, "findOne", (filter) => query(
    filter.reference === state.payment.reference &&
    (!filter.provider || filter.provider === state.payment.provider) &&
    (!filter.purpose || filter.purpose === state.payment.purpose)
      ? state.payment : null
  ));
  t.mock.method(Payment, "findById", () => query(state.payment));
  t.mock.method(Payment, "find", () => query(
    ["initialized", "processing"].includes(state.payment.status) ? [state.payment] : []
  ));
  t.mock.method(Payment, "findOneAndUpdate", (filter, update, options) => {
    assert.equal(options.session, session);
    if (!filter.status.$in.includes(state.payment.status)) return query(null);
    Object.assign(state.payment, update.$set);
    return query(state.payment);
  });
  t.mock.method(Payment, "updateOne", async (filter, update) => {
    if (filter.status?.$in && !filter.status.$in.includes(state.payment.status)) {
      return { matchedCount: 0 };
    }
    Object.assign(state.payment, update.$set);
    return { matchedCount: 1 };
  });
  t.mock.method(Transaction, "findOne", ({ reference }) =>
    query(state.ledger.find((entry) => entry.reference === reference) || null)
  );
  t.mock.method(Transaction, "create", async (rows, options) => {
    assert.equal(options.session, session);
    for (const row of rows) {
      assert.ok(!state.ledger.some((existing) => existing.reference === row.reference));
      state.ledger.push(row);
    }
    return rows;
  });
  t.mock.method(Log, "create", async (row) => { state.logs.push(row); return row; });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(url.endsWith(`/transaction/verify/${state.payment.reference}`));
    state.requests++;
    return { ok: true, json: async () => ({ status: true, data: structuredClone(state.gateway) }) };
  });

  state.input = {
    agentId: state.agent._id, amount: state.payment.amount,
    reason: "Deposit did not update wallet", reference: state.payment.reference,
  };
  return state;
}

test("requires a Paystack reference instead of a generated manual-credit key", () => {
  assert.deepEqual(
    validateAdminCredit({ amount: "12.345", reason: "  Payment   confirmed ", reference: " DP-paid-reference " }),
    { amount: 12.35, reason: "Payment confirmed", reference: "DP-paid-reference" }
  );

  for (const body of [
    { amount: 0, reason: "Valid reason", reference: "DP-reference" },
    { amount: MAX_ADMIN_CREDIT_GHS + 1, reason: "Valid reason", reference: "DP-reference" },
    { amount: 5, reason: "x", reference: "DP-reference" },
    { amount: 5, reason: "x".repeat(161), reference: "DP-reference" },
    { amount: 5, reason: "Valid reason", requestId: "request_123" },
    { amount: 5, reason: "Valid reason", reference: " " },
    { amount: 5, reason: "Valid reason", reference: "DP-reference/other" },
    { amount: 5, reason: "Valid reason", reference: "x".repeat(101) },
  ]) {
    assert.throws(() => validateAdminCredit(body), { status: 400 });
  }
});

test("verifies Paystack and credits only the deposit principal once across admin retries", async (t) => {
  const state = fixture(t);
  const first = await creditAgentWallet(state.input);
  const retry = await creditAgentWallet({ ...state.input, reason: "Retry after network delay" });

  assert.equal(first.alreadyCredited, false);
  assert.equal(retry.alreadyCredited, true);
  assert.equal(state.agent.wallet, 35.5);
  assert.equal(state.admin.wallet, 10, "customer-paid fee offsets the gateway fee");
  assert.equal(state.requests, 1);
  assert.equal(state.payment.status, "succeeded");
  assert.equal(first.agent._id, state.agent._id);
  assert.equal(first.transaction.type, "topup");
  assert.equal(first.transaction.amount, 25.5);
  assert.equal(first.transaction.reference, state.payment.reference);
  assert.deepEqual(state.ledger.map((row) => row.amount), [25.5, 0.51, -0.51]);
});

test("automatic recovery and webhooks cannot re-credit a deposit confirmed by admin", async (t) => {
  const state = fixture(t);
  await creditAgentWallet(state.input);
  assert.deepEqual(await syncPendingWalletTopups(), { checked: 0, credited: 0, errors: 0 });
  assert.equal((await verifyWalletTopup(state.payment.reference)).alreadySettled, true);
  assert.equal((await settleVerifiedPayment(state.payment.reference, state.gateway)).alreadySettled, true);
  assert.equal(state.agent.wallet, 35.5);
  assert.equal(state.ledger.filter((row) => row.type === "topup").length, 1);
  assert.equal(state.requests, 1);
});

test("admin returns the existing balance when recovery has already credited the payment", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await syncPendingWalletTopups(), { checked: 1, credited: 1, errors: 0 });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Gateway offline"); });
  const result = await creditAgentWallet(state.input);
  assert.equal(result.alreadyCredited, true);
  assert.equal(result.agent.wallet, 35.5);
  assert.equal(state.ledger.filter((row) => row.type === "topup").length, 1);
});

test("a webhook credit during admin verification is returned without a second credit", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    await settleVerifiedPayment(state.payment.reference, state.gateway);
    return { ok: true, json: async () => ({ status: true, data: { status: "pending" } }) };
  });
  const result = await creditAgentWallet(state.input);
  assert.equal(result.alreadyCredited, true);
  assert.equal(result.agent.wallet, 35.5);
  assert.equal(state.ledger.filter((row) => row.type === "topup").length, 1);
});

test("unknown references and payments belonging to another user cannot credit the selected wallet", async (t) => {
  const state = fixture(t);
  await assert.rejects(creditAgentWallet({ ...state.input, reference: "DP-unknown" }), { status: 404 });
  state.payment.agent = "other-agent";
  await assert.rejects(creditAgentWallet(state.input), { status: 409 });
  assert.equal(state.requests, 0);
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("order payments and direct payments cannot be used as wallet deposits", async (t) => {
  const state = fixture(t);
  for (const purpose of ["storefront_order", "portal_order", "checker_order"]) {
    state.payment.purpose = purpose;
    await assert.rejects(creditAgentWallet(state.input), { status: 400 });
  }
  state.payment.purpose = "wallet_topup";
  state.payment.provider = "agent_direct";
  await assert.rejects(creditAgentWallet(state.input), { status: 400 });
  assert.equal(state.requests, 0);
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("an incorrect amount or a fee-inclusive amount is rejected before verification", async (t) => {
  const state = fixture(t);
  for (const amount of [20, state.payment.chargedAmount]) {
    await assert.rejects(creditAgentWallet({ ...state.input, amount }), { status: 400 });
  }
  assert.equal(state.requests, 0);
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("pending, failed, and reversed Paystack transactions do not credit the wallet", async (t) => {
  const state = fixture(t);
  for (const status of ["pending", "failed", "reversed"]) {
    state.gateway.status = status;
    await assert.rejects(creditAgentWallet(state.input), { status: 409 });
    assert.equal(state.payment.gatewayStatus, status);
  }
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("a gateway outage leaves the deposit retryable without applying an admin credit", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Gateway unavailable"); });
  await assert.rejects(creditAgentWallet(state.input), { status: 502 });
  assert.equal(state.payment.status, "initialized");
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("refunded deposits and success records without a matching credit cannot add money", async (t) => {
  const state = fixture(t);
  state.payment.status = "refunded";
  await assert.rejects(creditAgentWallet(state.input), { status: 409 });
  state.payment.status = "succeeded";
  await assert.rejects(creditAgentWallet(state.input), { status: 409 });
  assert.equal(state.requests, 0);
  assert.equal(state.agent.wallet, 10);
  assert.equal(state.ledger.length, 0);
});

test("only an existing agent can receive an admin-confirmed deposit", async (t) => {
  const state = fixture(t);
  await assert.rejects(creditAgentWallet({ ...state.input, agentId: "missing-agent" }), { status: 404 });
  state.agent.role = "superadmin";
  await assert.rejects(creditAgentWallet(state.input), { status: 409 });
  assert.equal(state.requests, 0);
  assert.equal(state.agent.wallet, 10);
});

test("admin credit endpoint records the Paystack reference, reason, and administrator in its audit", async (t) => {
  const state = fixture(t);
  const handle = router.stack.find((layer) => layer.route?.path === "/agents/:id/credit").route.stack[0].handle;
  const responses = [];
  let status;
  const res = {
    status: (value) => { status = value; return res; },
    json: (body) => { responses.push({ status, ...body.data }); },
  };
  const req = { params: { id: state.agent._id }, agent: state.admin, body: state.input };
  const next = (error) => { throw error; };
  await handle(req, res, next);
  await handle(req, res, next);

  assert.deepEqual(responses.map((response) => response.status), [201, 200]);
  assert.deepEqual(responses.map((response) => response.alreadyCredited), [false, true]);
  assert.equal(responses[0].agent._id, state.agent._id);
  const audit = state.logs.filter((log) => log.source === "admin/agents");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].meta.reference, state.payment.reference);
  assert.equal(audit[0].meta.reason, state.input.reason);
  assert.equal(audit[0].meta.creditedBy, state.admin._id);
  assert.match(audit[0].message, /by Super Admin/);
});
