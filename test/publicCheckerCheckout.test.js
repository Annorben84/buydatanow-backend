import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.NETPLUSE_API_KEY = "np_test_public_checker";
process.env.PAYSTACK_MODE = "test";
process.env.PAYSTACK_SECRET_KEY_TEST = "sk_test_public_checker";
const { Agent, Store, Payment, Settings, Transaction, Log } = await import("../src/models/index.js");
const { AgentCheckerMargin } = await import("../src/models/AgentCheckerMargin.js");
const { CheckerPurchase } = await import("../src/models/CheckerPurchase.js");
const { checkerAccessHash, hasCheckerAccess, publicCheckerCatalog, initializePublicCheckerCheckout } = await import("../src/lib/publicCheckerCheckout.js");
const { settleCheckerPurchase, refundPublicCheckerPurchase, reserveCheckerPurchase } = await import("../src/lib/checkerPurchases.js");
const { settleVerifiedPayment } = await import("../src/lib/paymentSettlement.js");
const { paymentMismatch } = await import("../src/lib/paymentValidation.js");
const { customerPaystackCharge } = await import("../src/lib/paystackFee.js");
const { default: publicRouter } = await import("../src/publicCheckerRoutes.js");
const { default: checkerRouter } = await import("../src/checkerRoutes.js");
const query = (value) => {
  const result = Promise.resolve(value);
  for (const method of ["select", "session", "sort", "lean"]) result[method] = () => query(value);
  return result;
};
const key = "abcdef0123456789".repeat(4);
const input = { type: "waec", quantity: 2, email: "buyer@example.test", unitPrice: 22.5, accessKey: key, storeSlug: "shop" };

function catalogFixture(t) {
  const state = { owner: { _id: "agent1", role: "agent", name: "Agent", wallet: 100, commissionAvailable: 0 }, admin: { _id: "admin1", role: "superadmin", name: "Admin", wallet: 0 }, payment: null, initialized: 0 };
  t.mock.method(Settings, "findOne", async () => ({ waecCheckerMargin: 2, beceCheckerMargin: 1 }));
  t.mock.method(Store, "findOne", (filter) => { assert.equal(filter.slug, "shop"); return query({ _id: "store1", slug: "shop", agent: "agent1", status: "active" }); });
  t.mock.method(Agent, "findOne", (filter) => query(filter.role ? state.admin : state.owner));
  t.mock.method(AgentCheckerMargin, "find", (filter) => { assert.deepEqual(filter, { agent: "agent1" }); return query([{ type: "waec", margin: 3 }]); });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/checkers")) return { ok: true, status: 200, json: async () => ({ checkers: [{ id: "waec", name: "WAEC", price: 17.5 }, { id: "bece", name: "BECE", price: 10 }] }) };
    assert.ok(url.endsWith("/transaction/initialize"));
    state.initialized++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.amount, customerPaystackCharge(45).totalSubunit);
    assert.equal(payload.metadata.checkerType, "waec");
    assert.equal(payload.metadata.checkerQuantity, 2);
    assert.equal(payload.metadata.storeSlug, "shop");
    assert.equal(JSON.stringify(payload).includes(key), false, "private recovery key must not reach Paystack");
    return { ok: true, status: 200, json: async () => ({ status: true, data: { authorization_url: "https://checkout.paystack.com/checker-test" } }) };
  });
  t.mock.method(Payment, "findOne", () => query(state.payment));
  t.mock.method(Payment, "create", async (data) => { state.payment = { _id: "payment1", checkerCheckoutUrl: "", ...data }; return state.payment; });
  t.mock.method(Payment, "findOneAndUpdate", (_filter, update) => { Object.assign(state.payment, update.$set); return query(state.payment); });
  t.mock.method(Payment, "updateOne", async (_filter, update) => { Object.assign(state.payment, update.$set); });
  return state;
}

test("homepage uses platform price, storefront adds only the owning agent's margin", async (t) => {
  catalogFixture(t);
  assert.equal((await publicCheckerCatalog()).items[0].unitPrice, 19.5);
  const store = await publicCheckerCatalog("shop");
  assert.equal(store.items[0].unitPrice, 22.5);
  assert.equal(store.items[0].agentMargin, 3);
  assert.equal(store.items[1].unitPrice, 11, "an unset agent margin defaults to zero");
});

test("guest checkout captures trusted prices, hashes the private key, and reuses one payment on retry", async (t) => {
  const state = catalogFixture(t);
  const first = await initializePublicCheckerCheckout(input);
  const second = await initializePublicCheckerCheckout(input);
  assert.equal(first.reference, second.reference);
  assert.equal(state.initialized, 1);
  assert.equal(state.payment.amount, 45);
  assert.equal(state.payment.agentMargin, 6);
  assert.equal(state.payment.platformMargin, 4);
  assert.equal(state.payment.checkerAccessHash, checkerAccessHash(key));
  assert.equal(state.payment.checkerAccessHash.includes(key), false);
  assert.equal(JSON.stringify(first).includes(key), false);
  await assert.rejects(() => initializePublicCheckerCheckout({ ...input, quantity: 3 }), /another purchase/);
});

test("forged guest prices cannot initialize a payment", async (t) => {
  const state = catalogFixture(t);
  await assert.rejects(() => initializePublicCheckerCheckout({ ...input, unitPrice: 0.01 }), /price changed/);
  assert.equal(state.payment, null);
  assert.equal(state.initialized, 0);
});

test("guest PIN lookup requires the private key even if the payment reference is known", async (t) => {
  t.mock.method(Payment, "findOne", () => query({ reference: "CP-test", checkerAccessHash: checkerAccessHash(key) }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not contact provider without access"); });
  const handle = publicRouter.stack.find((layer) => layer.route?.path === "/purchases/:reference").route.stack[0].handle;
  let code;
  const res = { status: (status) => { code = status; return res; }, json: () => {} };
  await handle({ params: { reference: "CP-test" }, get: () => "0".repeat(64) }, res, (error) => { throw error; });
  assert.equal(code, 404);
  assert.equal(hasCheckerAccess({ checkerAccessHash: checkerAccessHash(key) }, key), true);
});

test("authenticated seller cannot recover a guest's PINs by replaying its reference as a wallet purchase", async (t) => {
  t.mock.method(CheckerPurchase, "findOne", (filter) => {
    assert.deepEqual(filter.channel, { $ne: "public" });
    throw new Error("wallet scope checked");
  });
  await assert.rejects(() => reserveCheckerPurchase({ _id: "agent1" }, { type: "waec", quantity: 1, reference: "CP-private-customer" }), /wallet scope checked/);
});

const paidIntent = () => ({
  _id: "payment1", reference: "CP-paid", purpose: "checker_order", status: "initialized", provider: "paystack",
  amount: 45, chargedAmount: 45.9, customerFee: 0.9, gatewayFee: 0.9, currency: "GHS", agent: "agent1", storeSlug: "shop",
  checkerType: "waec", checkerQuantity: 2, providerCost: 35, agentMargin: 6, platformMargin: 4,
  save: async () => {},
});
const gatewayPayment = () => ({ reference: "CP-paid", status: "success", amount: 4590, currency: "GHS", id: "gateway1", fees: 90, metadata: { purpose: "checker_order", agentId: "agent1", storeSlug: "shop", checkerType: "waec", checkerQuantity: 2 } });

test("payment verification checks checker type, quantity and storefront", () => {
  const intent = paidIntent(); const gateway = gatewayPayment();
  assert.equal(paymentMismatch(intent, gateway), "");
  for (const [field, value] of [["checkerType", "bece"], ["checkerQuantity", 3], ["storeSlug", "other"]]) {
    assert.notEqual(paymentMismatch(intent, { ...gateway, metadata: { ...gateway.metadata, [field]: value } }), "");
  }
});

test("verified public payments book one checker purchase with no seller wallet debit", async (t) => {
  const payment = paidIntent();
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }));
  t.mock.method(Payment, "findOne", () => query(payment));
  t.mock.method(Payment, "findById", () => query(payment));
  t.mock.method(Payment, "findOneAndUpdate", (_filter, update) => { Object.assign(payment, update.$set); return query(payment); });
  t.mock.method(Agent, "findById", () => query({ _id: "agent1", name: "Agent", wallet: 100 }));
  t.mock.method(Agent, "findByIdAndUpdate", () => { throw new Error("Public purchase must not debit the seller"); });
  let bookings = 0;
  t.mock.method(CheckerPurchase, "create", async ([data]) => { bookings++; assert.equal(data.channel, "public"); assert.equal(data.agentMargin, 6); return [{ _id: "checker1", ...data }]; });
  t.mock.method(CheckerPurchase, "findOneAndUpdate", () => query(null));
  await settleVerifiedPayment(payment.reference, gatewayPayment());
  await settleVerifiedPayment(payment.reference, gatewayPayment());
  assert.equal(bookings, 1);
  assert.equal(payment.status, "fulfilling");
});

function settlementFixture(t, failed = false) {
  const payment = { ...paidIntent(), status: "fulfilling" };
  const purchase = { _id: "checker1", reference: payment.reference, paymentReference: payment.reference, channel: "public", agent: "agent1", type: "waec", quantity: 2, amount: 45, providerCost: 35, agentMargin: 6, settledAt: null, status: "processing", providerStatus: failed ? "failed" : "completed", pins: failed ? [] : [{ serial: "S1", pin: "P1" }, { serial: "S2", pin: "P2" }], save: async () => {} };
  const state = { payment, purchase, seller: { _id: "agent1", name: "Agent", wallet: 100, commissionAvailable: 0 }, admin: { _id: "admin1", name: "Admin", wallet: 0 }, ledger: [] };
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }));
  t.mock.method(CheckerPurchase, "findById", () => query(purchase));
  t.mock.method(CheckerPurchase, "updateOne", async (_filter, update) => { Object.assign(purchase, update.$set); });
  t.mock.method(Payment, "findOne", () => query(payment));
  t.mock.method(Payment, "findById", () => query(payment));
  t.mock.method(Payment, "findOneAndUpdate", async (_filter, update) => { Object.assign(payment, update.$set); return payment; });
  t.mock.method(Payment, "updateOne", async (_filter, update) => { Object.assign(payment, update.$set); });
  t.mock.method(Agent, "findByIdAndUpdate", async (_id, update) => { assert.equal(update.$inc.wallet, undefined); state.seller.commissionAvailable += update.$inc.commissionAvailable; return state.seller; });
  t.mock.method(Agent, "findOne", () => query(state.admin));
  t.mock.method(Agent, "updateOne", async (_filter, update) => { state.admin.wallet += update.$inc.wallet; });
  t.mock.method(Transaction, "create", async (rows) => { state.ledger.push(...rows); });
  return state;
}

test("delivered guest PINs credit agent and platform margins exactly once", async (t) => {
  const state = settlementFixture(t);
  await settleCheckerPurchase("checker1");
  await settleCheckerPurchase("checker1");
  assert.equal(state.seller.wallet, 100);
  assert.equal(state.seller.commissionAvailable, 6);
  assert.equal(state.admin.wallet, 4);
  assert.equal(state.purchase.status, "completed");
  assert.equal(state.payment.status, "fulfilled");
  assert.equal(state.ledger.length, 4);
});

test("failed guest delivery refunds the original payment, never the agent wallet", async (t) => {
  const state = settlementFixture(t, true);
  t.mock.method(Log, "create", async () => ({}));
  let refunds = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.endsWith("/refund")); refunds++;
    assert.equal(JSON.parse(options.body).amount, 4590);
    return { ok: true, status: 200, json: async () => ({ status: true, data: { status: "processed" } }) };
  });
  await settleCheckerPurchase("checker1");
  assert.equal(state.purchase.status, "refund_pending");
  await refundPublicCheckerPurchase(state.purchase);
  await refundPublicCheckerPurchase(state.purchase);
  assert.equal(state.purchase.status, "refunded");
  assert.equal(refunds, 1);
  assert.equal(state.seller.wallet, 100);
  assert.equal(state.seller.commissionAvailable, 0);
  assert.equal(state.admin.wallet, 0);
});

test("agent margin writes use the signed-in owner and reject negative margins", async (t) => {
  const handle = checkerRouter.stack.find((layer) => layer.route?.path === "/margins/:type").route.stack[0].handle;
  let writes = 0;
  t.mock.method(AgentCheckerMargin, "findOneAndUpdate", async (filter, update) => {
    writes++;
    assert.deepEqual(filter, { agent: "agent1", type: "waec" });
    return { type: "waec", margin: update.$set.margin };
  });
  let status = 200;
  const res = { status: (code) => { status = code; return res; }, json: () => {} };
  const req = { agent: { _id: "agent1" }, params: { type: "waec" }, body: { agent: "other-agent", margin: 3.25 } };
  await handle(req, res, (error) => { throw error; });
  assert.equal(writes, 1);
  await handle({ ...req, body: { margin: -1 } }, res, (error) => { throw error; });
  assert.equal(status, 400);
  assert.equal(writes, 1);
});

test("a completed refund webhook is not overwritten by a delayed pending refund response", async (t) => {
  const state = settlementFixture(t, true);
  t.mock.method(Log, "create", async () => ({}));
  t.mock.method(Payment, "updateOne", async (filter, update) => {
    assert.deepEqual(filter.status, { $ne: "refunded" });
    if (state.payment.status !== "refunded") Object.assign(state.payment, update.$set);
  });
  t.mock.method(globalThis, "fetch", async () => {
    state.payment.status = "refunded"; // Simulates the signed webhook winning the race.
    return { ok: true, status: 200, json: async () => ({ status: true, data: { status: "pending" } }) };
  });
  await settleCheckerPurchase("checker1");
  await refundPublicCheckerPurchase(state.purchase);
  assert.equal(state.payment.status, "refunded");
  assert.equal(state.purchase.status, "refunded");
});
