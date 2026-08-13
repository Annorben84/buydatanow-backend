import { createHmac, timingSafeEqual } from "node:crypto";

const PAYSTACK_BASE = "https://api.paystack.co";

// PAYSTACK_MODE: "auto" (live in production-like envs, else test), "live", or "test".
const MODE = (process.env.PAYSTACK_MODE || "auto").toLowerCase();

/** In "auto" mode, treat production-like environments (NODE_ENV or a real, non-
 *  localhost CLIENT_URL) as LIVE, and everything else as TEST. */
function looksProduction() {
  if (process.env.NODE_ENV === "production") return true;
  const url = process.env.CLIENT_URL || "";
  return url !== "" && !/localhost|127\.0\.0\.1/i.test(url);
}

const useLive = MODE === "live" || (MODE === "auto" && looksProduction());

// Pick the key pair for the active mode; fall back to legacy single keys if set.
const SECRET =
  (useLive ? process.env.PAYSTACK_SECRET_KEY_LIVE : process.env.PAYSTACK_SECRET_KEY_TEST) ||
  process.env.PAYSTACK_SECRET_KEY;
const PUBLIC =
  (useLive ? process.env.PAYSTACK_PUBLIC_KEY_LIVE : process.env.PAYSTACK_PUBLIC_KEY_TEST) ||
  process.env.PAYSTACK_PUBLIC_KEY;
const TIMEOUT_MS = Number(process.env.PAYSTACK_TIMEOUT_MS) || 20000;

/** The effective Paystack environment in use: "live" or "test". */
export const paystackMode = () => (useLive ? "live" : "test");

/** The active public key (safe to expose to the browser). */
export const paystackPublicKey = () => PUBLIC || "";

/** Whether a Paystack secret key is configured for the active mode. */
export const paystackConfigured = () => !!SECRET;

/** First allowed frontend origin — where Paystack sends the user back. */
export function clientOrigin() {
  return (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim();
}

/** Call the Paystack REST API with the secret key. */
export async function paystack(path, options = {}) {
  if (!SECRET) {
    return { ok: false, status: 0, json: { message: "Paystack is not configured." } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, transportError: false };
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? `Paystack did not respond within ${TIMEOUT_MS}ms.`
        : err?.message || "Paystack is unreachable.";
    return { ok: false, status: 0, json: { message }, transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate `x-paystack-signature` against the untouched webhook body. */
export function validPaystackSignature(rawBody, signature) {
  if (!SECRET || !Buffer.isBuffer(rawBody) || typeof signature !== "string") return false;
  const expected = createHmac("sha512", SECRET).update(rawBody).digest("hex");
  const supplied = signature.trim().toLowerCase();
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}
