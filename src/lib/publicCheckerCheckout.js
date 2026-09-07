import { createHash, timingSafeEqual } from "node:crypto";
import { Agent, Store, Payment } from "../models/index.js";
import { AgentCheckerMargin } from "../models/AgentCheckerMargin.js";
import { checkerCatalog } from "./checkerPurchases.js";
import { customerPaystackCharge } from "./paystackFee.js";
import { paystack, paystackConfigured, clientOrigin } from "./paystackApi.js";

const money = (n) => Math.round(Number(n) * 100) / 100;
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

export function checkerAccessHash(key) {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw problem("Enter the 64-character recovery key saved with your purchase.");
  return createHash("sha256").update(key).digest("hex");
}

export function hasCheckerAccess(payment, key) {
  try {
    const supplied = Buffer.from(checkerAccessHash(key), "hex");
    const saved = Buffer.from(payment?.checkerAccessHash || "", "hex");
    return supplied.length === saved.length && timingSafeEqual(supplied, saved);
  } catch { return false; }
}

export async function publicCheckerCatalog(slug = "") {
  let store = null;
  let owner;
  if (slug) {
    store = await Store.findOne({ slug: slug.toLowerCase(), status: "active" }).lean();
    if (!store) throw problem("This store is not accepting orders.", 404);
    owner = await Agent.findOne({ _id: store.agent, status: "active" }).lean();
  } else {
    owner = await Agent.findOne({ role: "superadmin", status: "active" }).sort({ createdAt: 1 }).lean();
  }
  if (!owner) throw problem("Result checker sales are temporarily unavailable.", 503);
  const [catalog, margins] = await Promise.all([
    checkerCatalog("agent"),
    store && owner.role !== "superadmin" ? AgentCheckerMargin.find({ agent: owner._id }).lean() : [],
  ]);
  const items = catalog.map((row) => {
    const margin = money(margins.find((entry) => entry.type === row.type)?.margin || 0);
    const unitPrice = money(row.unitPrice + margin);
    const charge = customerPaystackCharge(unitPrice);
    return { ...row, platformPrice: row.unitPrice, agentMargin: margin, unitPrice, chargedUnitPrice: charge.totalSubunit / 100 };
  });
  return { store, owner, items };
}

export function publicCheckerCatalogItem(row) {
  return { type: row.type, name: row.name, description: row.description, available: row.available, maxQuantity: row.maxQuantity, unitPrice: row.unitPrice };
}

/** A private random recovery key also identifies retries of one immutable checkout. */
export async function initializePublicCheckerCheckout(body) {
  if (!paystackConfigured()) throw problem("Payments are temporarily unavailable.", 503);
  const hash = checkerAccessHash(body?.accessKey);
  const reference = `CP-${hash.slice(0, 40)}`;
  const type = body?.type;
  const quantity = body?.quantity;
  const slug = typeof body?.storeSlug === "string" ? body.storeSlug.trim().toLowerCase() : "";
  const email = String(body?.email || "").trim().toLowerCase();
  if (!["waec", "bece"].includes(type) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw problem("Choose WAEC or BECE and a quantity from 1 to 50.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw problem("Enter a valid receipt email.");
  let payment = await Payment.findOne({ reference, purpose: "checker_order" }).select("+checkerAccessHash +checkerCheckoutUrl");
  if (!payment) {
    const { store, owner, items } = await publicCheckerCatalog(slug);
    const item = items.find((entry) => entry.type === type);
    if (!item?.available) throw problem("This checker is currently unavailable.", 409);
    if (money(body.unitPrice) !== item.unitPrice) throw problem("The price changed. Refresh prices and confirm the new total.", 409);
    const amount = money(item.unitPrice * quantity);
    const charge = customerPaystackCharge(amount);
    try {
      payment = await Payment.create({
        reference, purpose: "checker_order", provider: "paystack", status: "initialized",
        amount, chargedAmount: charge.totalSubunit / 100, customerFee: charge.feeSubunit / 100,
        currency: "GHS", email, agent: owner._id, store: store?._id, storeSlug: store?.slug || "",
        checkerType: type, checkerQuantity: quantity, checkerAccessHash: hash,
        platformPrice: money(item.platformPrice * quantity), providerCost: money(item.baseCost * quantity),
        agentMargin: money(item.agentMargin * quantity), platformMargin: money((item.platformPrice - item.baseCost) * quantity),
        paymentDestination: "platform", verificationMode: "gateway", settlementModel: "platform_collected",
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      payment = await Payment.findOne({ reference, purpose: "checker_order" }).select("+checkerAccessHash +checkerCheckoutUrl");
    }
  }
  if (!hasCheckerAccess(payment, body.accessKey)) throw problem("Purchase not found.", 404);
  if (payment.checkerType !== type || payment.checkerQuantity !== quantity || payment.email !== email || payment.storeSlug !== slug) {
    throw problem("This recovery key belongs to another purchase. Open the saved purchase first.", 409);
  }
  const result = () => ({ reference, amount: payment.amount, chargedAmount: payment.chargedAmount, customerFee: payment.customerFee, status: payment.status, authorizationUrl: payment.checkerCheckoutUrl || "" });
  if (payment.checkerCheckoutUrl || payment.status !== "initialized") return result();
  const claimed = await Payment.findOneAndUpdate({
    _id: payment._id, status: "initialized", checkerCheckoutUrl: "",
    $or: [{ checkerInitLeaseUntil: null }, { checkerInitLeaseUntil: { $lte: new Date() } }],
  }, { $set: { checkerInitLeaseUntil: new Date(Date.now() + 60000) } }, { new: true });
  if (!claimed) return result();
  try {
    const returnPath = slug ? `/store/${encodeURIComponent(slug)}/result-checkers` : "/result-checkers";
    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST", body: JSON.stringify({
        reference, email: payment.email, amount: Math.round(payment.chargedAmount * 100), currency: "GHS",
        callback_url: `${clientOrigin().replace(/\/$/, "")}${returnPath}?payment_reference=${encodeURIComponent(reference)}`,
        channels: ["mobile_money"],
        metadata: { purpose: "checker_order", agentId: String(payment.agent), checkerType: type, checkerQuantity: quantity, storeSlug: slug },
      }),
    });
    if (!ok || !json?.status || !json?.data?.authorization_url) throw problem("Checkout is not ready yet. Retry this saved purchase.", 503);
    const url = new URL(json.data.authorization_url);
    if (url.protocol !== "https:" || !(url.hostname === "paystack.com" || url.hostname.endsWith(".paystack.com"))) throw problem("The payment provider returned an invalid checkout address.", 502);
    payment.checkerCheckoutUrl = url.toString();
    await Payment.updateOne({ _id: payment._id }, { $set: { checkerCheckoutUrl: payment.checkerCheckoutUrl, gatewayStatus: "checkout_created" } });
    return result();
  } finally {
    await Payment.updateOne({ _id: payment._id }, { $set: { checkerInitLeaseUntil: null } });
  }
}
