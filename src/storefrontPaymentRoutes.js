import { randomUUID } from "node:crypto";
import { Router } from "express";

import { Agent, AgentPrice, Bundle, Payment, Store } from "./models/index.js";
import { clientOrigin, paystack, paystackConfigured } from "./lib/paystackApi.js";
import { customerPaystackCharge, paystackFeePercent } from "./lib/paystackFee.js";
import {
  PaymentSettlementError,
  settleVerifiedPayment,
} from "./lib/paymentSettlement.js";
import {
  normalizePhone,
  remaLive,
  remaWalletBalance,
  resolveProviderBundle,
  validPhone,
} from "./lib/remaApi.js";

const router = Router();
const money = (n) => Math.round(Number(n) * 100) / 100;

/** The legacy endpoint spent an agent wallet without proving customer payment. */
router.post("/stores/slug/:slug/buy", (_req, res) => {
  res.status(410).json({
    error: "Direct storefront purchases are disabled. Complete checkout through Paystack.",
  });
});

/** Create an immutable checkout intent after provider-availability checks. */
router.post("/stores/slug/:slug/pay/init", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(503).json({ error: "Online payments aren't configured right now." });
    }
    if (!remaLive()) {
      return res.status(503).json({ error: "Data delivery is temporarily unavailable." });
    }

    const slug = req.params.slug.toLowerCase();
    const store = await Store.findOne({ slug });
    if (!store) return res.status(404).json({ error: "Store not found" });
    if (store.status !== "active") {
      return res.status(409).json({ error: "This store isn't accepting orders right now." });
    }

    const network = String(req.body.network || "").trim();
    const gb = Number(req.body.gb) || 0;
    const phone = normalizePhone(req.body.phone || "");
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const [bundle, owner, ownPrice, providerBundle, providerWallet] = await Promise.all([
      Bundle.findOne({ carrier: network, gb, active: true }).lean(),
      store.agent ? Agent.findOne({ _id: store.agent, status: "active" }).lean() : null,
      store.agent ? AgentPrice.findOne({ agent: store.agent, carrier: network, gb }).lean() : null,
      resolveProviderBundle(network, gb),
      remaWalletBalance(),
    ]);
    if (!bundle) return res.status(400).json({ error: "That bundle isn't available." });
    if (!owner) return res.status(409).json({ error: "This store isn't ready to take orders yet." });
    if (!providerBundle) {
      return res.status(503).json({ error: "That bundle is temporarily unavailable for delivery." });
    }
    if (!providerWallet.ok) {
      return res.status(503).json({ error: "The delivery provider is temporarily unavailable." });
    }
    if (Number(providerWallet.balance) < Number(providerBundle.cost)) {
      return res.status(503).json({ error: "That bundle cannot be delivered right now. Please try later." });
    }

    const platformPrice = money(bundle.price);
    const providerCost = money(providerBundle.cost || bundle.cost || 0);
    const amount = money(ownPrice?.price ?? platformPrice);
    if (amount < platformPrice) {
      return res.status(409).json({ error: "This store's bundle price needs administrator review." });
    }
    const agentMargin = money(amount - platformPrice);
    const platformMargin = money(Math.max(0, platformPrice - providerCost));
    const email = String(req.body.email || "").trim() || owner.email || "orders@buydatanow.store";
    const reference = `DP-${randomUUID()}`;
    const charge = customerPaystackCharge(amount);
    const chargedAmount = money(charge.totalSubunit / 100);
    const customerFee = money(charge.feeSubunit / 100);

    const intent = await Payment.create({
      reference,
      purpose: "storefront_order",
      amount,
      chargedAmount,
      customerFee,
      currency: "GHS",
      email,
      agent: owner._id,
      store: store._id,
      storeSlug: slug,
      network,
      gb,
      phone,
      platformPrice,
      providerCost,
      agentMargin,
      platformMargin,
    });

    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: charge.totalSubunit,
        currency: "GHS",
        reference,
        callback_url: `${clientOrigin()}/store/${store.slug}`,
        metadata: {
          purpose: "storefront_order",
          storeSlug: slug,
          agentId: String(owner._id),
          network,
          gb,
          phone,
        },
      }),
    });
    if (!ok || !json?.status) {
      await Payment.updateOne(
        { _id: intent._id },
        { $set: { failureReason: json?.message || "Could not initialize Paystack." } }
      );
      return res.status(502).json({ error: json?.message || "Could not start the payment." });
    }

    res.json({
      data: {
        authorization_url: json.data.authorization_url,
        reference,
        amount,
        fee: customerFee,
        chargedAmount,
        feePercent: paystackFeePercent(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Verify the gateway response and settle the saved checkout exactly once. */
router.post("/stores/slug/:slug/pay/verify", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(503).json({ error: "Online payments aren't configured right now." });
    }
    const reference = String(req.body.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing payment reference." });

    const intent = await Payment.findOne({ reference, purpose: "storefront_order" }).lean();
    if (!intent) return res.status(404).json({ error: "Payment intent not found." });
    if (intent.storeSlug !== req.params.slug.toLowerCase()) {
      return res.status(403).json({ error: "This payment belongs to another store." });
    }

    const { ok, json } = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!ok || !json?.status) {
      return res.status(502).json({ error: json?.message || "Could not verify the payment." });
    }
    if (json.data?.status !== "success") {
      await Payment.updateOne(
        { _id: intent._id },
        { $set: { gatewayStatus: String(json.data?.status || "unknown") } }
      );
      return res.json({ data: { status: json.data?.status || "unknown" } });
    }

    const result = await settleVerifiedPayment(reference, json.data);
    res.status(result.alreadySettled ? 200 : 201).json({
      data: {
        status: result.status,
        order: result.order,
        alreadyFulfilled: result.alreadySettled,
      },
    });
  } catch (err) {
    if (err instanceof PaymentSettlementError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

export default router;
