import test from "node:test";
import assert from "node:assert/strict";

process.env.PAYSTACK_MODE = "test";
process.env.PAYSTACK_SECRET_KEY_TEST = "sk_test_fixture";
process.env.NETPLUSE_FULFILMENT = "off";
process.env.NETPLUSE_ALLOW_SIMULATED_SALES = "true";

const { default: catalogRouter } = await import("../src/routes.js");
const { default: checkoutRouter } = await import("../src/storefrontPaymentRoutes.js");
const { Store, Agent, AgentPrice, Bundle, Payment } = await import("../src/models/index.js");
const { customerPaystackCharge } = await import("../src/lib/paystackFee.js");

function handler(router, path) {
  return router.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
}

test("storefront catalog and checkout use the store owner's price, ignoring customer-supplied prices", async (t) => {
  const bundle = { _id: "bundle1", carrier: "MTN", gb: 1, size: "1 GB", price: 5, cost: 4, active: true };
  let sellingPrice = 8;
  const store = { _id: "store1", slug: "shop", agent: "owner1", status: "active" };
  t.mock.method(Store, "findOne", (filter) => {
    assert.deepEqual(filter, { slug: "shop" });
    return Object.assign(Promise.resolve(store), { lean: async () => store });
  });
  t.mock.method(Bundle, "find", () => ({ lean: async () => [bundle] }));
  t.mock.method(Bundle, "findOne", () => ({ lean: async () => bundle }));
  t.mock.method(Agent, "findOne", (filter) => {
    assert.deepEqual(filter, { _id: "owner1", status: "active" });
    return { lean: async () => ({ _id: "owner1", role: "agent", email: "owner@example.com" }) };
  });
  t.mock.method(AgentPrice, "find", (filter) => {
    assert.deepEqual(filter, { agent: "owner1" });
    return { lean: async () => sellingPrice === null ? [] : [{ carrier: "MTN", gb: 1, price: sellingPrice }] };
  });
  t.mock.method(AgentPrice, "findOne", (filter) => {
    assert.deepEqual(filter, { agent: "owner1", carrier: "MTN", gb: 1 });
    return { lean: async () => sellingPrice === null ? null : { price: sellingPrice } };
  });
  let intent;
  let gatewayAmount;
  t.mock.method(Payment, "create", async (data) => { intent = data; return { ...data, _id: "payment1" }; });
  t.mock.method(Payment, "updateOne", async () => ({}));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.paystack.co/transaction/initialize");
    gatewayAmount = JSON.parse(options.body).amount;
    return { ok: true, json: async () => ({ status: true, data: { authorization_url: "https://checkout.paystack.com/test", access_code: "test" } }) };
  });
  for (const price of [8, 9.5, null]) {
    sellingPrice = price;
    const expected = price ?? bundle.price;
    let response;
    const res = { status: () => res, json: (body) => { response = body; } };
    const next = (error) => { throw error; };
    const req = { params: { slug: "SHOP" }, body: { network: "MTN", gb: 1, phone: "0240000000", price: 0.01, amount: 0.01, agent: "other-owner" } };
    await handler(catalogRouter, "/stores/slug/:slug/bundles")(req, res, next);
    assert.equal(response.data[0].price, expected);
    await handler(checkoutRouter, "/stores/slug/:slug/pay/init")(req, res, next);
    assert.equal(response.data.amount, expected);
    assert.equal(intent.amount, expected);
    assert.equal(intent.agent, "owner1");
    assert.equal(intent.agentMargin, expected - bundle.price);
    assert.equal(gatewayAmount, customerPaystackCharge(expected).totalSubunit);
  }
});
