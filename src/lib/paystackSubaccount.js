import { normalizePhone, validPhone } from "./netpluseApi.js";
import { paystack, paystackConfigured, paystackMode } from "./paystackApi.js";

const PROVIDER_ALIASES = {
  mtn: ["mtn"],
  atl: ["atl", "airteltigo", "atmoney"],
  vod: ["vod", "vodafone", "telecel"],
};

const searchable = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export class PaystackSubaccountError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "PaystackSubaccountError";
    this.status = status;
  }
}

export function validMomoProvider(provider) {
  return Object.hasOwn(PROVIDER_ALIASES, String(provider || "").toLowerCase());
}

export function findMomoSettlementBank(provider, banks = []) {
  const normalizedProvider = String(provider || "").toLowerCase();
  if (!validMomoProvider(normalizedProvider)) return null;
  const aliases = PROVIDER_ALIASES[normalizedProvider];
  return (
    banks.find((entry) => {
      const terms = [entry.code, entry.name, entry.slug].map(searchable);
      return aliases.some((alias) => terms.some((term) => term.includes(alias)));
    }) || null
  );
}

export async function resolveMomoSettlementBank(provider, apiCall = paystack) {
  const normalizedProvider = String(provider || "").toLowerCase();
  if (!validMomoProvider(normalizedProvider)) {
    throw new PaystackSubaccountError("Choose MTN, AT Money, or Telecel Mobile Money.", 400);
  }

  const { ok, json } = await apiCall("/bank?currency=GHS&type=mobile_money&perPage=100");
  if (!ok || !json?.status || !Array.isArray(json.data)) {
    throw new PaystackSubaccountError(
      json?.message || "Could not load Paystack's supported Mobile Money providers."
    );
  }

  const bank = findMomoSettlementBank(normalizedProvider, json.data);
  if (!bank?.code) {
    throw new PaystackSubaccountError(
      "That Mobile Money provider is not currently available for Paystack settlement.",
      409
    );
  }
  return bank;
}

export async function provisionPaystackSubaccount(
  {
    existingCode = "",
    businessName,
    momoProvider,
    momoName,
    momoNumber,
    contactEmail = "",
  },
  dependencies = {}
) {
  const apiCall = dependencies.api || paystack;
  const configured = dependencies.configured || paystackConfigured;
  const mode = dependencies.mode || paystackMode;
  if (!configured()) {
    throw new PaystackSubaccountError("Paystack is not configured on the platform.", 503);
  }

  const phone = normalizePhone(momoNumber);
  if (!validPhone(phone)) {
    throw new PaystackSubaccountError("Enter a valid Ghana Mobile Money number.", 400);
  }
  if (String(momoName || "").trim().length < 2) {
    throw new PaystackSubaccountError("Enter the registered Mobile Money account name.", 400);
  }

  const bank = await resolveMomoSettlementBank(momoProvider, apiCall);
  const code = String(existingCode || "").trim();
  const updating = /^ACCT_[A-Za-z0-9]+$/.test(code);
  const payload = {
    business_name: String(businessName || momoName).trim(),
    settlement_bank: String(bank.code),
    account_number: phone,
    percentage_charge: 0,
    description: `Customer payments for ${String(businessName || momoName).trim()}`,
    primary_contact_email: String(contactEmail || "").trim(),
    primary_contact_name: String(momoName).trim(),
    primary_contact_phone: phone,
    metadata: JSON.stringify({ momoProvider: String(momoProvider).toLowerCase() }),
  };

  const { ok, json } = await apiCall(
    updating ? `/subaccount/${encodeURIComponent(code)}` : "/subaccount",
    {
      method: updating ? "PUT" : "POST",
      body: JSON.stringify(payload),
    }
  );
  if (!ok || !json?.status || !json.data?.subaccount_code) {
    throw new PaystackSubaccountError(
      json?.message || `Could not ${updating ? "update" : "create"} the Paystack subaccount.`
    );
  }

  return {
    paystackSubaccountCode: String(json.data.subaccount_code),
    paystackSubaccountId: String(json.data.id || ""),
    paystackSettlementName: String(json.data.account_name || momoName).trim(),
    paystackSubaccountActive: json.data.active !== false,
    paystackSubaccountVerified: Boolean(json.data.is_verified),
    paystackSubaccountMode: mode(),
    paymentAccount: phone,
  };
}
