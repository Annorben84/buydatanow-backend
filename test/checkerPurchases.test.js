import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.NETPLUSE_API_KEY = "np_test_checker_fixture";
const { Agent, Transaction, Settings } = await import("../src/models/index.js");
const { CheckerPurchase } = await import("../src/models/CheckerPurchase.js");
const { validateCheckerPurchase, checkerResponse, completeCheckerPins, reserveCheckerPurchase, syncCheckerPurchase, settleCheckerPurchase, publicCheckerPurchase } = await import("../src/lib/checkerPurchases.js");
const { default: router } = await import("../src/checkerRoutes.js");

const query = (value) => {
  const result = Promise.resolve(value);
  result.session = () => Promise.resolve(value);
  result.select = () => query(value);
  result.sort = () => query(value);
  return result;
};
const response = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });

function fixture(t) {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  const state = { purchase: null, agent: { _id: "agent1", name: "Buyer", role: "agent", status: "active", wallet: 100 }, admin: { _id: "admin1", name: "Admin", wallet: 0 }, ledger: [] };
  t.mock.method(Settings, "findOne", async () => ({ waecCheckerMargin: 2, beceCheckerMargin: 3 }));
  t.mock.method(CheckerPurchase, "findOne", () => query(state.purchase));
  t.mock.method(CheckerPurchase, "findById", () => query(state.purchase));
  t.mock.method(CheckerPurchase, "create", async (rows, options) => {
    assert.equal(options.session, session);
    state.purchase = { _id: "purchase1", ...rows[0], status: "pending", pins: [], providerStatus: "", providerReference: "", dispatchedAt: null, leaseUntil: null, nextSyncAt: new Date(0), settledAt: null, save: async ({ session: value }) => { assert.equal(value, session); } };
    return [state.purchase];
  });
  t.mock.method(CheckerPurchase, "findOneAndUpdate", (_filter, update) => {
    if (!state.purchase || !["pending", "processing"].includes(state.purchase.status) || state.purchase.leaseUntil > new Date() || state.purchase.nextSyncAt > new Date()) return query(null);
    Object.assign(state.purchase, update.$set);
    return query(state.purchase);
  });
  t.mock.method(CheckerPurchase, "updateOne", async (_filter, update) => { Object.assign(state.purchase, update.$set); });
  t.mock.method(Agent, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(options.session, session);
    if (state.agent.wallet < filter.wallet.$gte) return null;
    state.agent.wallet += update.$inc.wallet;
    return state.agent;
  });
  t.mock.method(Agent, "findByIdAndUpdate", async (_id, update) => { state.agent.wallet += update.$inc.wallet; return state.agent; });
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (_filter, update) => { state.admin.wallet += update.$inc.wallet; });
  t.mock.method(Transaction, "create", async (rows, options) => { assert.equal(options.session, session); state.ledger.push(...rows); return rows; });
  return state;
}

const input = { type: "waec", quantity: 2, reference: "client-ref-123", unitPrice: 19.5 };
const catalog = { checkers: [{ id: "waec", name: "WAEC", price: 17.5 }, { id: "bece", name: "BECE", price: 10 }] };
const delivered = { reference: "NPCHK-1", type: "waec", quantity: 2, total_cost: 35, status: "completed", pins: [{ serial: "SER1", pin: "00001234", expires: "2027-06-30" }, { serial: "SER2", pin: "00005678", expires: "2027-06-30" }] };

test("validates type, integer quantity, and durable retry key", () => {
  assert.deepEqual(validateCheckerPurchase(input), { type: "waec", quantity: 2, reference: "client-ref-123" });
  for (const body of [{ ...input, type: "other" }, { ...input, quantity: 0 }, { ...input, quantity: 51 }, { ...input, quantity: 1.5 }, { ...input, quantity: "1" }, { ...input, reference: "" }]) {
    assert.throws(() => validateCheckerPurchase(body));
  }
});

test("immediate delivery saves all pins before settlement, debits once and credits the superadmin margin once", async (t) => {
  const state = fixture(t);
  let purchases = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/checkers")) return response(catalog);
    assert.ok(state.purchase, "intent must be saved before the provider call");
    assert.equal(state.agent.wallet, 61);
    assert.ok(url.endsWith("/checkers/purchase"));
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { type: "waec", quantity: 2, reference: state.purchase.reference });
    purchases++;
    return response(delivered);
  });
  await reserveCheckerPurchase(state.agent, input);
  const createLedger = Transaction.create;
  t.mock.method(Transaction, "create", async (rows, options) => {
    assert.equal(state.purchase.pins.length, 2, "pins must be stored before margin settlement");
    return createLedger(rows, options);
  });
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "completed");
  assert.equal(state.purchase.pins[0].pin, "00001234");
  assert.equal(state.admin.wallet, 4);
  await reserveCheckerPurchase(state.agent, input);
  await syncCheckerPurchase("purchase1");
  await settleCheckerPurchase("purchase1");
  assert.equal(purchases, 1);
  assert.equal(state.agent.wallet, 61);
  assert.equal(state.admin.wallet, 4);
  assert.equal(state.ledger.length, 2);
  assert.equal(publicCheckerPurchase(state.purchase).pins, undefined);
  assert.equal(publicCheckerPurchase(state.purchase, true).pins.length, 2);
});

test("stale quotes, insufficient wallet and changed retries cannot create a new debit", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => response(catalog));
  await assert.rejects(() => reserveCheckerPurchase(state.agent, { ...input, unitPrice: 0.01 }), /price changed/);
  state.agent.wallet = 1;
  await assert.rejects(() => reserveCheckerPurchase(state.agent, input), /too low/);
  assert.equal(state.purchase, null);
  state.agent.wallet = 100;
  await reserveCheckerPurchase(state.agent, input);
  await assert.rejects(() => reserveCheckerPurchase(state.agent, { ...input, quantity: 3 }), /different purchase/);
  assert.equal(state.agent.wallet, 61);
});

test("BECE uses its own platform margin", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => response(catalog));
  await reserveCheckerPurchase(state.agent, { ...input, type: "bece", quantity: 1, unitPrice: 13 });
  assert.equal(state.purchase.amount, 13);
  assert.equal(state.purchase.providerCost, 10);
});

test("processing purchase recovers pins by its provider reference without buying again", async (t) => {
  const state = fixture(t);
  let stage = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/checkers")) return response(catalog);
    if (url.endsWith("/checkers/purchase")) { stage++; return response({ reference: "NPCHK-1", type: "waec", quantity: 2, status: "processing" }); }
    if (url.endsWith("/order-status/NPCHK-1")) return response({ reference: "NPCHK-1", status: "processing" });
    assert.ok(url.endsWith("/checkers/NPCHK-1"));
    return response(delivered);
  });
  await reserveCheckerPurchase(state.agent, input);
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "processing");
  state.purchase.nextSyncAt = new Date(0);
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "completed");
  assert.equal(stage, 1);
});

test("timeout keeps the charge pending and retries an unknown purchase with the same provider key", async (t) => {
  const state = fixture(t);
  const references = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/checkers")) return response(catalog);
    if (url.endsWith("/checkers/purchase")) {
      references.push(JSON.parse(options.body).reference);
      if (references.length === 1) throw new Error("connection lost");
      return response(delivered);
    }
    return response({ error: "Not found" }, 404);
  });
  await reserveCheckerPurchase(state.agent, input);
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "processing");
  assert.equal(state.agent.wallet, 61);
  state.purchase.nextSyncAt = new Date(0);
  await syncCheckerPurchase("purchase1");
  assert.equal(references.length, 2);
  assert.equal(references[0], references[1]);
  assert.equal(state.purchase.status, "completed");
});

test("definitive rejection refunds exactly once; partial pins never trigger an automatic refund", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("/checkers") ? response(catalog) : response({ error: "Quantity exceeds your tier" }, 422));
  await reserveCheckerPurchase(state.agent, input);
  await syncCheckerPurchase("purchase1");
  assert.equal(state.agent.wallet, 100);
  assert.equal(state.purchase.status, "refunded");
  await settleCheckerPurchase("purchase1");
  assert.equal(state.agent.wallet, 100);
  assert.equal(state.ledger.filter((row) => row.type === "refund").length, 1);
  state.purchase.settledAt = null;
  state.purchase.status = "processing";
  state.purchase.pins = [delivered.pins[0]];
  await settleCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "processing");
  assert.equal(state.agent.wallet, 100);
});

test("provider responses must match the purchase and include all distinct PINs for completion", () => {
  const purchase = { type: "waec", quantity: 2, providerReference: "NPCHK-1" };
  assert.equal(checkerResponse({ ...delivered, type: "bece" }, purchase).valid, false);
  assert.equal(checkerResponse({ ...delivered, reference: "NPCHK-other" }, purchase).valid, false);
  assert.equal(completeCheckerPins({ ...purchase, pins: [delivered.pins[0], delivered.pins[0]] }), false);
  assert.equal(completeCheckerPins({ ...purchase, pins: delivered.pins }), true);
});

test("PIN detail lookup is scoped to the authenticated buyer before contacting the provider", async (t) => {
  t.mock.method(CheckerPurchase, "findOne", (filter) => {
    assert.deepEqual(filter, { agent: "other-agent", reference: "CHK-private", channel: { $ne: "public" } });
    return Promise.resolve(null);
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not contact provider for another buyer"); });
  const handle = router.stack.find((layer) => layer.route?.path === "/:reference").route.stack[0].handle;
  let status;
  const res = { status: (code) => { status = code; return res; }, json: () => {} };
  await handle({ agent: { _id: "other-agent" }, params: { reference: "CHK-private" } }, res, (error) => { throw error; });
  assert.equal(status, 404);
});

test("an active reconciliation lease prevents a second provider call", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => response(catalog));
  await reserveCheckerPurchase(state.agent, input);
  state.purchase.leaseUntil = new Date(Date.now() + 120000);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Lease must prevent provider call"); });
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.dispatchedAt, null);
  assert.equal(state.agent.wallet, 61);
});

test("saved complete PINs settle after recovery without another provider purchase", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async () => response(catalog));
  await reserveCheckerPurchase(state.agent, input);
  state.purchase.pins = delivered.pins;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Saved PINs must not be purchased again"); });
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "completed");
  assert.equal(state.admin.wallet, 4);
});

test("provider holds and completed responses without PINs remain pending", async (t) => {
  const state = fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/checkers")) return response(catalog);
    return response({ reference: "NPCHK-1", status: "on_hold", pins: [] });
  });
  await reserveCheckerPurchase(state.agent, input);
  await syncCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "processing");
  assert.equal(state.agent.wallet, 61);
  state.purchase.providerStatus = "completed";
  await settleCheckerPurchase("purchase1");
  assert.equal(state.purchase.status, "processing");
  assert.equal(state.admin.wallet, 0);
});
