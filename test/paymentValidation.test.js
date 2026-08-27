import test from "node:test";
import assert from "node:assert/strict";

import { paymentMismatch } from "../src/lib/paymentValidation.js";
import { customerPaystackCharge } from "../src/lib/paystackFee.js";
import { canSetSellingPrice, storefrontMargins } from "../src/lib/pricingPolicy.js";
import {
  capacityInGb,
  mapProviderStatus,
  netpluseSimulatedSalesAllowed,
  normalizePhone,
  validPhone,
} from "../src/lib/netpluseApi.js";

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

test("grosses up Ghana payments so the customer covers Paystack's fee", () => {
  assert.deepEqual(customerPaystackCharge(4.7), {
    principalSubunit: 470,
    feeSubunit: 9,
    totalSubunit: 479,
  });
  assert.deepEqual(customerPaystackCharge(50), {
    principalSubunit: 5000,
    feeSubunit: 99,
    totalSubunit: 5099,
  });
});

test("validates the customer-paid total while preserving the principal", () => {
  const intent = { ...walletIntent, chargedAmount: 50.99, customerFee: 0.99 };
  assert.equal(paymentMismatch(intent, { ...walletPayment, amount: 5099 }), "");
  assert.match(paymentMismatch(intent, walletPayment), /amount/i);
});

test("allows only superadmins to set a selling price below platform price", () => {
  assert.equal(canSetSellingPrice("agent", 4.5, 4.7), false);
  assert.equal(canSetSellingPrice("agent", 4.7, 4.7), true);
  assert.equal(canSetSellingPrice("superadmin", 4.5, 4.7), true);
});

test("charges a superadmin discount against platform margin", () => {
  assert.deepEqual(
    storefrontMargins({
      role: "superadmin",
      sellingPrice: 4.5,
      platformPrice: 4.7,
      providerCost: 4.2,
    }),
    { agentMargin: 0, platformMargin: 0.3 }
  );
});

test("splits a direct agent sale without crediting profit into the wallet", () => {
  const platformPrice = 4.7;
  const sellingPrice = 5.1;
  const economics = storefrontMargins({
    role: "agent",
    sellingPrice,
    platformPrice,
    providerCost: 4.4,
  });

  assert.deepEqual(economics, { agentMargin: 0.4, platformMargin: 0.3 });
  assert.equal(platformPrice, 4.7, "the prepaid wallet debit is provider cost plus commission");
  assert.equal(
    Math.round((sellingPrice - platformPrice) * 100) / 100,
    0.4,
    "the customer-paid difference stays with the agent"
  );
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
  assert.equal(capacityInGb("1GB"), 1);
  assert.equal(capacityInGb("500MB"), 0.5);
});

test("requires explicit opt-in before treating a sale as simulated", () => {
  const previous = process.env.NETPLUSE_ALLOW_SIMULATED_SALES;
  try {
    delete process.env.NETPLUSE_ALLOW_SIMULATED_SALES;
    assert.equal(netpluseSimulatedSalesAllowed(), false);
    process.env.NETPLUSE_ALLOW_SIMULATED_SALES = "true";
    assert.equal(netpluseSimulatedSalesAllowed(), true);
    process.env.NETPLUSE_ALLOW_SIMULATED_SALES = "false";
    assert.equal(netpluseSimulatedSalesAllowed(), false);
  } finally {
    if (previous === undefined) delete process.env.NETPLUSE_ALLOW_SIMULATED_SALES;
    else process.env.NETPLUSE_ALLOW_SIMULATED_SALES = previous;
  }
});
