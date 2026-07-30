/*
 * Rema Data — the upstream fulfilment provider.
 *
 * BuyDataNow resells Rema's bundles: every paid order is POSTed to their API,
 * which debits OUR Rema wallet and pushes the data to the recipient's line.
 * Requests authenticate with a secret key in the `X-API-KEY` header — server
 * side only, never the browser.
 *
 * Docs: https://remadata.com/api
 */

const REMA_BASE = (process.env.REMA_BASE_URL || "https://remadata.com/api").replace(/\/+$/, "");

/*
 * REMA_MODE picks which key signs requests: "live", "test", or "auto" (live in
 * production-like envs). ⚠ Rema issues `rd_live_` keys for BOTH and they share
 * ONE wallet — neither key is a sandbox, so this only chooses which credential
 * is used, not whether real money moves. REMA_FULFILMENT below is the switch
 * that actually stops real orders.
 */
const MODE = (process.env.REMA_MODE || "auto").toLowerCase();

/** Production-like = NODE_ENV=production, or a real (non-localhost) CLIENT_URL. */
function looksProduction() {
  if (process.env.NODE_ENV === "production") return true;
  const url = process.env.CLIENT_URL || "";
  return url !== "" && !/localhost|127\.0\.0\.1/i.test(url);
}

const useLive = MODE === "live" || (MODE === "auto" && looksProduction());

const KEY =
  (useLive ? process.env.REMA_API_KEY_LIVE : process.env.REMA_API_KEY_TEST) ||
  process.env.REMA_API_KEY;

/*
 * REMA_FULFILMENT decides whether orders are really sent upstream:
 *   auto → send only in production-like envs (default; free local development)
 *   on   → always send  ⚠ REAL MONEY leaves the Rema wallet on every order
 *   off  → never send; orders settle locally as "simulated"
 */
const FULFILMENT = (process.env.REMA_FULFILMENT || "auto").toLowerCase();

const TIMEOUT_MS = Number(process.env.REMA_TIMEOUT_MS) || 20000;

/** The key pair in use: "live" or "test". */
export const remaMode = () => (useLive ? "live" : "test");

/** Whether an API key is configured for the active mode. */
export const remaConfigured = () => !!KEY;

/** Whether orders are actually handed to Rema (vs. settled locally). */
export const remaLive = () =>
  remaConfigured() && (FULFILMENT === "on" || (FULFILMENT === "auto" && looksProduction()));

/** One-word summary for /api/health and the admin console. */
export function remaStatus() {
  if (!remaConfigured()) return "not-configured";
  return remaLive() ? `${remaMode()} · fulfilling` : `${remaMode()} · simulated`;
}

/* -------------------------------- transport ------------------------------- */

/**
 * Call the Rema Data API. Never throws: a network failure, timeout or provider
 * error all come back as `{ ok: false }` with a message, because the callers
 * sit on the money path and must always be able to settle the order.
 */
async function rema(path, options = {}) {
  if (!KEY) {
    return { ok: false, status: 0, json: { message: "Rema Data is not configured." } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${REMA_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "X-API-KEY": KEY,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const json = await res.json().catch(() => ({}));
    // Rema answers 200 with `{"status":"error"}` on business failures, so the
    // HTTP code alone isn't enough to tell success from rejection.
    return { ok: res.ok && json?.status !== "error", status: res.status, json };
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? `Rema Data did not respond within ${TIMEOUT_MS}ms.`
        : err?.message || "Rema Data is unreachable.";
    return { ok: false, status: 0, json: { message } };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- conversions ------------------------------ */

const NETWORK_BY_CARRIER = { MTN: "mtn", Telecel: "telecel", AirtelTigo: "airteltigo" };
const CARRIER_BY_NETWORK = { mtn: "MTN", telecel: "Telecel", airteltigo: "AirtelTigo" };

/** Our carrier name → Rema's `networkType`. */
export const providerNetwork = (carrier) => NETWORK_BY_CARRIER[carrier] || "";

/**
 * Ghana MSISDN in the 10-digit local form Rema expects (0XXXXXXXXX).
 * Accepts +233…, 233…, spaced and 9-digit input.
 */
export function normalizePhone(input = "") {
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("233")) return `0${digits.slice(3)}`;
  if (digits.length === 11 && digits.startsWith("00")) return `0${digits.slice(2)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

/** True when the number is a deliverable 10-digit Ghana line. */
export const validPhone = (input) => /^0\d{9}$/.test(normalizePhone(input));

/**
 * Bundle size in GB, read from Rema's `name` ("5GB (NON-EXPIRY)" → 5).
 *
 * The name is the only trustworthy size on their catalog: `volumeInMB` counts
 * in 1024s for MTN but 1000s for Telecel/AirtelTigo, and a couple of Telecel
 * rows carry a GB figure in that MB field ("50GB (90DAYS)" → volumeInMB 50).
 */
function gbFromName(name = "") {
  const match = String(name).match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (!match) return 0;
  const size = Number(match[1]);
  return match[2].toUpperCase() === "MB" ? size / 1024 : size;
}

/** Rema's order status → our `Order.status`. */
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
      return "processing"; // pending / processing / anything new — still in flight
  }
}

/* --------------------------------- catalog -------------------------------- */

const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalog = { at: 0, rows: [] };

/**
 * Rema's bundle list at OUR API pricing, normalized to our carrier names.
 * Cached for 5 minutes; a failed refresh keeps serving the last good list
 * rather than emptying the catalog mid-sale.
 */
export async function remaCatalog({ force = false } = {}) {
  const fresh = Date.now() - catalog.at < CATALOG_TTL_MS;
  if (!force && fresh && catalog.rows.length) return catalog.rows;

  const { ok, json } = await rema("/bundles");
  if (!ok || !Array.isArray(json?.data)) return catalog.rows;

  const rows = json.data
    .map((b) => ({
      carrier: CARRIER_BY_NETWORK[String(b.network || "").toLowerCase()] || "",
      gb: gbFromName(b.name),
      volumeInMB: Number(b.volumeInMB) || 0,
      cost: Number(b.price) || 0, // our cost — Rema's price to us
      name: String(b.name || ""),
    }))
    .filter((b) => b.carrier && b.gb > 0 && b.volumeInMB > 0);

  if (rows.length) catalog = { at: Date.now(), rows };
  return catalog.rows;
}

/**
 * The Rema row that fulfils one of our bundles, or null if they don't sell it.
 * Purchases must send back Rema's own `volumeInMB` verbatim — it identifies the
 * row in their system and can't be derived from the size (see `gbFromName`).
 */
export async function resolveProviderBundle(carrier, gb) {
  const rows = await remaCatalog();
  return rows.find((r) => r.carrier === carrier && r.gb === Number(gb)) || null;
}

/* --------------------------------- actions -------------------------------- */

/** Our Rema wallet — the float every order is paid from. */
export async function remaWalletBalance() {
  const { ok, json } = await rema("/wallet-balance");
  if (!ok) return { ok: false, message: json?.message || "Could not read the Rema balance." };
  return {
    ok: true,
    balance: Number(json?.data?.balance) || 0,
    currency: json?.data?.currency || "GHS",
    lastTransactionAt: json?.data?.last_transaction_at || null,
  };
}

/**
 * Buy a bundle for a recipient. ⚠ Spends our Rema wallet.
 *
 * `ref` is our own order reference, echoed back as `client_reference` so an
 * order can always be traced in both systems. Rema refunds itself when the
 * network can't fulfil, which surfaces as `refunded: true`.
 */
export async function remaBuyData({ ref, phone, carrier, gb }) {
  const match = await resolveProviderBundle(carrier, gb);
  if (!match) {
    return { ok: false, message: `Rema Data doesn't sell a ${carrier} ${gb}GB bundle.` };
  }

  const { ok, json } = await rema("/buy-data", {
    method: "POST",
    body: JSON.stringify({
      ref,
      phone: normalizePhone(phone),
      volumeInMB: match.volumeInMB,
      networkType: providerNetwork(carrier),
    }),
  });

  const data = json?.data || {};
  return {
    ok,
    message: json?.message || "",
    providerRef: data.reference || "",
    status: ok ? mapProviderStatus(data.status || "pending") : "failed",
    cost: Number(data.amount) || match.cost,
    refunded: data.refunded === true,
    balance: data.balance != null ? Number(data.balance) : null,
  };
}

/** Current provider-side status of an order, by Rema's own reference. */
export async function remaOrderStatus(providerRef) {
  const { ok, json } = await rema(`/order-status/${encodeURIComponent(providerRef)}`);
  if (!ok) return { ok: false, message: json?.message || "Could not read the order status." };
  const data = json?.data || json?.order || {};
  return {
    ok: true,
    status: mapProviderStatus(data.status || ""),
    raw: String(data.status || ""),
    message: json?.message || "",
  };
}

/** Our orders on Rema's side. Accepts their documented filters (ref, status, …). */
export async function remaOrders(params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  ).toString();
  const { ok, json } = await rema(`/orders${query ? `?${query}` : ""}`);
  if (!ok) return { ok: false, message: json?.message || "Could not read orders." };
  const data = json?.data;
  return { ok: true, orders: Array.isArray(data) ? data : data?.orders || data?.data || [] };
}
