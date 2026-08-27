/*
 * Netpluse — upstream data-bundle fulfilment.
 *
 * The API key is server-only. Purchases use our order reference as Netpluse's
 * idempotency key so a retry after a timeout cannot create a second order.
 *
 * Docs: https://netpluse.shop/api/v1
 */

const NETPLUSE_BASE = (
  process.env.NETPLUSE_BASE_URL || "https://netpluse.shop/api/v1"
).replace(/\/+$/, "");
const KEY = process.env.NETPLUSE_API_KEY || "";
const FULFILMENT = (process.env.NETPLUSE_FULFILMENT || "auto").toLowerCase();
const TIMEOUT_MS = Number(process.env.NETPLUSE_TIMEOUT_MS) || 20000;

/** Production-like = NODE_ENV=production, or a real (non-localhost) CLIENT_URL. */
function looksProduction() {
  if (process.env.NODE_ENV === "production") return true;
  const url = process.env.CLIENT_URL || "";
  return url !== "" && !/localhost|127\.0\.0\.1/i.test(url);
}

export const netpluseConfigured = () => Boolean(KEY);
export const netpluseMode = () => (KEY.startsWith("np_live_") ? "live" : "configured");
export const netpluseLive = () =>
  netpluseConfigured() &&
  (FULFILMENT === "on" || (FULFILMENT === "auto" && looksProduction()));
export const netpluseSimulatedSalesAllowed = () =>
  String(process.env.NETPLUSE_ALLOW_SIMULATED_SALES || "").toLowerCase() === "true";

export function netpluseStatus() {
  if (netpluseLive()) return `${netpluseMode()} · fulfilling`;
  if (netpluseSimulatedSalesAllowed()) return `${netpluseMode()} · simulated`;
  return netpluseConfigured() ? `${netpluseMode()} · paused` : "not-configured";
}

async function netpluse(path, options = {}) {
  if (!KEY) {
    return { ok: false, status: 0, json: { error: "Netpluse is not configured." } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${NETPLUSE_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "x-api-key": KEY,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const json = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      json,
      transportError: false,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `Netpluse did not respond within ${TIMEOUT_MS}ms.`
        : error?.message || "Netpluse is unreachable.";
    return {
      ok: false,
      status: 0,
      json: { error: message },
      transportError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

const CARRIER_BY_NETWORK = {
  mtn: "MTN",
  telecel: "Telecel",
  airteltigo: "AirtelTigo",
};

export function normalizePhone(input = "") {
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("233")) return `0${digits.slice(3)}`;
  if (digits.length === 11 && digits.startsWith("00")) return `0${digits.slice(2)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

export const validPhone = (input) => /^0\d{9}$/.test(normalizePhone(input));

export function capacityInGb(capacity = "") {
  const match = String(capacity).trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  if (!match) return 0;
  const size = Number(match[1]);
  return match[2].toUpperCase() === "MB" ? size / 1000 : size;
}

export function mapProviderStatus(status = "") {
  switch (String(status).toLowerCase()) {
    case "completed":
    case "success":
    case "delivered":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "processing";
  }
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalog = { at: 0, rows: [] };

export async function netpluseCatalog({ force = false } = {}) {
  const fresh = Date.now() - catalog.at < CATALOG_TTL_MS;
  if (!force && fresh && catalog.rows.length) return catalog.rows;

  const { ok, json } = await netpluse("/packages");
  const packages = json?.packages ?? json?.data?.packages ?? json?.data;
  if (!ok || !Array.isArray(packages)) return catalog.rows;

  const rows = packages
    .map((item) => {
      const capacity = String(item.capacity || "").trim().replace(/\s+/g, "").toUpperCase();
      return {
        carrier: CARRIER_BY_NETWORK[String(item.network || "").toLowerCase()] || "",
        gb: capacityInGb(capacity),
        capacity,
        cost: Number(item.price) || 0,
        name: capacity,
        validity: String(item.validity || ""),
      };
    })
    .filter((item) => item.carrier && item.gb > 0 && item.capacity && item.cost >= 0);

  if (rows.length) catalog = { at: Date.now(), rows };
  return catalog.rows;
}

export async function resolveProviderBundle(carrier, gb) {
  const rows = await netpluseCatalog();
  return rows.find((item) => item.carrier === carrier && item.gb === Number(gb)) || null;
}

export async function netpluseWalletBalance() {
  const { ok, json } = await netpluse("/balance");
  if (!ok) {
    return {
      ok: false,
      message: json?.error || json?.message || "Could not read the Netpluse balance.",
    };
  }
  const data = json?.data || json;
  return {
    ok: true,
    balance: Number(data?.balance) || 0,
    currency: String(data?.currency || "GHS"),
    lastTransactionAt: null,
  };
}

/** Buy data. This is the only function in this module that can spend provider funds. */
export async function netpluseBuyData({ ref, phone, carrier, gb }) {
  const match = await resolveProviderBundle(carrier, gb);
  if (!match) {
    return { ok: false, message: `Netpluse doesn't sell a ${carrier} ${gb}GB bundle.` };
  }

  const { ok, status, json, transportError } = await netpluse("/purchase", {
    method: "POST",
    body: JSON.stringify({
      network: match.carrier,
      phoneNumber: normalizePhone(phone),
      capacity: match.capacity,
      reference: ref,
    }),
  });

  const message = json?.error || json?.message || "";
  if (!ok && (transportError || status === 409)) {
    return {
      ok: false,
      indeterminate: true,
      message:
        message ||
        "Netpluse may already have accepted this idempotent order; awaiting reconciliation.",
    };
  }

  const data = json?.data || json;
  return {
    ok,
    message,
    providerRef: String(data?.reference || ""),
    status: ok ? mapProviderStatus(data?.status || "processing") : "failed",
    cost: Number(data?.price) || match.cost,
    balance: data?.balance == null ? null : Number(data.balance),
  };
}

export async function netpluseOrderStatus(providerRef) {
  const { ok, json } = await netpluse(
    `/order-status/${encodeURIComponent(providerRef)}`
  );
  if (!ok) {
    return {
      ok: false,
      message: json?.error || json?.message || "Could not read the Netpluse order status.",
    };
  }
  const data = json?.data || json;
  const raw = String(data?.status || "processing");
  return {
    ok: true,
    providerRef: String(data?.reference || providerRef),
    status: mapProviderStatus(raw),
    raw,
    message: String(data?.message || ""),
    cost: Number(data?.price) || 0,
  };
}
