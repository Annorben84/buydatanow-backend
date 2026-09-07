import test from "node:test";
import assert from "node:assert/strict";
import router from "../src/routes.js";
import { Bundle, AgentPrice } from "../src/models/index.js";
import { walletPurchaseEconomics } from "../src/lib/pricingPolicy.js";

test("agent catalog and wallet use platform prices regardless of resale prices", async (t) => {
  let platformPrice = 4.7;
  t.mock.method(Bundle, "find", (filter) => {
    assert.deepEqual(filter, { active: true });
    return { lean: async () => [{ _id: "bundle1", carrier: "MTN", gb: 1, size: "1 GB", price: platformPrice }] };
  });
  t.mock.method(AgentPrice, "find", () => { throw new Error("Resale prices must not be used for agent purchases"); });
  const handler = router.stack.find((layer) => layer.route?.path === "/my-bundles").route.stack[0].handle;
  for (const price of [4.7, 5.2, 4.5]) {
    platformPrice = price;
    let data;
    await handler({ agent: { _id: "agent1", role: "agent" } }, { json: (body) => { data = body.data; } }, (err) => { throw err; });
    assert.equal(data[0].price, price);
    assert.deepEqual(walletPurchaseEconomics({ role: "agent", platformPrice: data[0].price, providerCost: 4.4, sellingPrice: 8 }), {
      amount: price, agentMargin: 0, refundAmount: price,
    });
  }
});
