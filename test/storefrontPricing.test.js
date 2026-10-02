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
    return { lean: async () => ({ _id: "owner1", role: "agent", email: "owner@example.com", wallet: 100 }) };
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

test("storefront checkout requires enough owner balance before creating a payment", async (t) => {
  const store = { _id: "store1", slug: "shop", agent: "owner1", status: "active" };
  const bundle = { carrier: "MTN", gb: 1, price: 12, cost: 10, active: true };
  const owner = { _id: "owner1", role: "agent", email: "owner@example.com", wallet: 10 };
  let sellingPrice = 14;

  t.mock.method(Store, "findOne", async () => store);
  t.mock.method(Bundle, "findOne", () => ({ lean: async () => bundle }));
  t.mock.method(Agent, "findOne", () => ({ lean: async () => owner }));
  t.mock.method(AgentPrice, "findOne", () => ({
    lean: async () => sellingPrice === null ? null : { price: sellingPrice },
  }));
  const createPayment = t.mock.method(Payment, "create", async (data) => ({ ...data, _id: "payment1" }));
  const updatePayment = t.mock.method(Payment, "updateOne", async () => ({}));
  const gateway = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/test", access_code: "test" },
    }),
  }));

  for (const scenario of [
    { wallet: 0, price: 14, status: 402 },
    { wallet: undefined, price: 14, status: 402 },
    { wallet: 10, price: 14, status: 402 },
    { wallet: 13.99, price: 14, status: 402 },
    { wallet: 14, price: 14, status: 201 },
    { wallet: 20, price: 14, status: 201 },
    { wallet: 10, price: null, status: 402 },
    { wallet: 12, price: null, status: 201 },
  ]) {
    const expectedAmount = scenario.price ?? bundle.price;
    await t.test(`balance ${scenario.wallet ?? "missing"}, bundle price ${expectedAmount}`, async () => {
      owner.wallet = scenario.wallet;
      sellingPrice = scenario.price;
      createPayment.mock.resetCalls();
      updatePayment.mock.resetCalls();
      gateway.mock.resetCalls();
      let status;
      let response;
      const res = {
        status: (code) => { status = code; return res; },
        json: (body) => { response = body; },
      };
      const req = {
        params: { slug: "shop" },
        body: { network: "MTN", gb: 1, phone: "0240000000", price: 0.01, amount: 0.01, agent: "other-owner" },
      };

      await handler(checkoutRouter, "/stores/slug/:slug/pay/init")(req, res, (error) => { throw error; });

      assert.equal(status, scenario.status);
      assert.equal(owner.wallet, scenario.wallet);
      if (scenario.status === 402) {
        assert.deepEqual(response, { error: "Store Balance is low contact Your Store" });
        assert.equal(createPayment.mock.callCount(), 0);
        assert.equal(updatePayment.mock.callCount(), 0);
        assert.equal(gateway.mock.callCount(), 0);
      } else {
        assert.equal(response.data.amount, expectedAmount);
        assert.equal(createPayment.mock.callCount(), 1);
        assert.equal(updatePayment.mock.callCount(), 1);
        assert.equal(gateway.mock.callCount(), 1);
        assert.equal(createPayment.mock.calls[0].arguments[0].amount, expectedAmount);
        assert.equal(createPayment.mock.calls[0].arguments[0].agent, "owner1");
        assert.equal(JSON.parse(gateway.mock.calls[0].arguments[1].body).amount, customerPaystackCharge(expectedAmount).totalSubunit);
      }
    });
  }
});
