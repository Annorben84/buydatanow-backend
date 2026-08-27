import test from "node:test";
import assert from "node:assert/strict";

import {
  findMomoSettlementBank,
  provisionPaystackSubaccount,
  validMomoProvider,
} from "../src/lib/paystackSubaccount.js";

const banks = [
  { name: "AirtelTigo", slug: "atl-mobile-money", code: "ATL" },
  { name: "MTN Mobile Money", slug: "mtn-mobile-money", code: "MTN" },
  { name: "Telecel Cash", slug: "vod-mobile-money", code: "VOD" },
];

test("accepts only Paystack's Ghana MoMo provider choices", () => {
  assert.equal(validMomoProvider("mtn"), true);
  assert.equal(validMomoProvider("atl"), true);
  assert.equal(validMomoProvider("vod"), true);
  assert.equal(validMomoProvider("card"), false);
});

test("matches each checkout provider to its Paystack settlement institution", () => {
  assert.equal(findMomoSettlementBank("mtn", banks)?.code, "MTN");
  assert.equal(findMomoSettlementBank("atl", banks)?.code, "ATL");
  assert.equal(findMomoSettlementBank("vod", banks)?.code, "VOD");
  assert.equal(findMomoSettlementBank("unknown", banks), null);
});

test("creates a zero-platform-share subaccount from an agent's MoMo details", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/bank?")) {
      return { ok: true, json: { status: true, data: banks } };
    }
    return {
      ok: true,
      json: {
        status: true,
        data: {
          id: 42,
          subaccount_code: "ACCT_agentstore",
          account_name: "BERNARD MENSAH",
          active: true,
          is_verified: false,
        },
      },
    };
  };

  const result = await provisionPaystackSubaccount(
    {
      businessName: "Bernard Data Hub",
      momoProvider: "mtn",
      momoName: "Bernard Mensah",
      momoNumber: "024 000 0000",
      contactEmail: "bernard@example.com",
    },
    { api, configured: () => true, mode: () => "test" }
  );

  assert.equal(calls[1].path, "/subaccount");
  assert.equal(calls[1].options.method, "POST");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.settlement_bank, "MTN");
  assert.equal(body.account_number, "0240000000");
  assert.equal(body.percentage_charge, 0);
  assert.equal(result.paystackSubaccountCode, "ACCT_agentstore");
  assert.equal(result.paystackSettlementName, "BERNARD MENSAH");
  assert.equal(result.paystackSubaccountActive, true);
});
