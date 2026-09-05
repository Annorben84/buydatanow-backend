import test from "node:test";
import assert from "node:assert/strict";

import { platformCollectedEarnings } from "../src/lib/platformEarnings.js";

test("calculates delivery-settled storefront balances", () => {
  assert.deepEqual(
    platformCollectedEarnings({
      agentMargin: 3.5,
      platformMargin: 1.25,
      principal: 20,
      chargedAmount: 20.7,
      gatewayFee: 0.7,
    }),
    {
      agentCommission: 3.5,
      platformMargin: 1.25,
      feeRecovery: 0.7,
      gatewayFee: 0.7,
      platformNet: 1.25,
    }
  );
});

test("never creates negative commission or fee recovery", () => {
  assert.deepEqual(
    platformCollectedEarnings({
      agentMargin: -2,
      platformMargin: -0.25,
      principal: 20,
      chargedAmount: 19,
      gatewayFee: -1,
    }),
    {
      agentCommission: 0,
      platformMargin: -0.25,
      feeRecovery: 0,
      gatewayFee: 0,
      platformNet: -0.25,
    }
  );
});
