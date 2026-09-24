import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { Agent, Transaction } from "../src/models/index.js";
import {
  creditAgentWallet,
  MAX_ADMIN_CREDIT_GHS,
  validateAdminCredit,
} from "../src/lib/adminCredit.js";

const query = (value) => ({ session: async () => value });

function fixture(t) {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  const agent = { _id: "agent-1", name: "Ama Agent", role: "agent", wallet: 10 };
  const ledger = [];

  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Transaction, "findOne", ({ reference }) =>
    query(ledger.find((entry) => entry.reference === reference) || null)
  );
  t.mock.method(Agent, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(filter._id, agent._id);
    assert.deepEqual(filter.role, { $ne: "superadmin" });
    assert.equal(options.session, session);
    agent.wallet += update.$inc.wallet;
    return agent;
  });
  t.mock.method(Agent, "findById", () => query(agent));
  t.mock.method(Transaction, "create", async (rows, options) => {
    assert.equal(options.session, session);
    ledger.push(...rows);
    return rows;
  });

  return { agent, ledger };
}

test("validates manual credit amounts, reasons, and idempotency keys", () => {
  assert.deepEqual(
    validateAdminCredit({ amount: "12.345", reason: "  Support   adjustment ", requestId: "request_123" }),
    { amount: 12.35, reason: "Support adjustment", requestId: "request_123" }
  );

  for (const body of [
    { amount: 0, reason: "Valid reason", requestId: "request_123" },
    { amount: MAX_ADMIN_CREDIT_GHS + 1, reason: "Valid reason", requestId: "request_123" },
    { amount: 5, reason: "x", requestId: "request_123" },
    { amount: 5, reason: "Valid reason", requestId: "bad" },
  ]) {
    assert.throws(() => validateAdminCredit(body), { status: 400 });
  }
});

test("credits the wallet and writes one funding ledger row exactly once", async (t) => {
  const { agent, ledger } = fixture(t);
  const input = {
    agentId: agent._id,
    amount: 25.5,
    reason: "Resolved payment issue",
    requestId: "request_123",
    adminName: "Super Admin",
  };

  const first = await creditAgentWallet(input);
  const retry = await creditAgentWallet(input);

  assert.equal(first.alreadyCredited, false);
  assert.equal(retry.alreadyCredited, true);
  assert.equal(agent.wallet, 35.5);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, "funding");
  assert.equal(ledger[0].amount, 25.5);
  assert.equal(ledger[0].agentId, agent._id);
  assert.equal(ledger[0].reference, "ADMIN-CREDIT-request_123");
  assert.match(ledger[0].description, /Resolved payment issue · by Super Admin/);
});
