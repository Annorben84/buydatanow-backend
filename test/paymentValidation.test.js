import test from "node:test";
import assert from "node:assert/strict";

import { paymentMismatch } from "../src/lib/paymentValidation.js";
import { mapProviderStatus, normalizePhone, validPhone } from "../src/lib/remaApi.js";

const walletIntent = {
  reference: "DP-test-reference",
  purpose: "wallet_topup",
  amount: 50,
  currency: "GHS",
  agent: "agent-1",
};

const walletPayment = {
  id: 123,
  reference: walletIntent.reference,
  status: "success",
  amount: 5000,
  currency: "GHS",
  metadata: { purpose: "wallet_topup", agentId: "agent-1" },
};

test("accepts a Paystack payment only when it exactly matches the wallet intent", () => {
  assert.equal(paymentMismatch(walletIntent, walletPayment), "");
});

test("rejects forged or changed Paystack settlement fields", () => {
  assert.match(paymentMismatch(walletIntent, { ...walletPayment, amount: 4999 }), /amount/i);
  assert.match(paymentMismatch(walletIntent, { ...walletPayment, currency: "NGN" }), /currency/i);
  assert.match(
    paymentMismatch(walletIntent, {
      ...walletPayment,
      metadata: { ...walletPayment.metadata, agentId: "agent-2" },
    }),
    /account/i
  );
});

test("validates every storefront fulfilment field", () => {
  const intent = {
    ...walletIntent,
    purpose: "storefront_order",
    storeSlug: "acme-data",
    network: "MTN",
    gb: 5,
    phone: "0240000000",
  };
  const payment = {
    ...walletPayment,
    metadata: {
      purpose: "storefront_order",
      agentId: "agent-1",
      storeSlug: "acme-data",
      network: "MTN",
      gb: 5,
      phone: "0240000000",
    },
  };
  assert.equal(paymentMismatch(intent, payment), "");
  assert.match(
    paymentMismatch(intent, { ...payment, metadata: { ...payment.metadata, phone: "0550000000" } }),
    /recipient/i
  );
});

test("normalizes Ghana recipients and provider terminal states", () => {
  assert.equal(normalizePhone("+233 24 000 0000"), "0240000000");
  assert.equal(validPhone("0240000000"), true);
  assert.equal(validPhone("123"), false);
  assert.equal(mapProviderStatus("delivered"), "completed");
  assert.equal(mapProviderStatus("refunded"), "refunded");
  assert.equal(mapProviderStatus("pending"), "processing");
});
