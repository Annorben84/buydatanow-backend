import { Router } from "express";

import { Transaction } from "./models/index.js";
import { requireAuth, publicAgent } from "./lib/auth.js";
import { paystack, paystackConfigured, clientOrigin } from "./lib/paystackApi.js";

const router = Router();
router.use(requireAuth);

const money = (n) => Math.round(n * 100) / 100;

/**
 * POST /api/wallet/paystack/init — start a wallet top-up.
 * Amount is authoritative here (server-side); returns Paystack's hosted
 * checkout URL to redirect the user to. TEST MODE: no real money moves —
 * complete it with a Paystack test card.
 */
router.post("/init", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Paystack is not configured (PAYSTACK_SECRET_KEY)." });
    }
    const amount = money(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter a valid amount." });
    }
    if (!req.agent.email) {
      return res.status(400).json({ error: "Your account needs an email to pay with Paystack." });
    }

    const reference = `DP-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: req.agent.email,
        amount: Math.round(amount * 100), // subunit (pesewas/kobo)
        reference,
        callback_url: `${clientOrigin()}/agent/add-fund`,
        metadata: { agentId: String(req.agent._id), purpose: "wallet_topup" },
      }),
    });

    if (!ok || !json?.status) {
      return res.status(502).json({ error: json?.message || "Could not start the payment." });
    }
    res.json({
      data: {
        authorization_url: json.data.authorization_url,
        reference: json.data.reference,
        access_code: json.data.access_code,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/wallet/paystack/verify — confirm a payment and credit the wallet.
 * Idempotent: a reference is only ever credited once. Credits the amount
 * Paystack actually confirms (never what the client claims).
 */
router.post("/verify", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Paystack is not configured (PAYSTACK_SECRET_KEY)." });
    }
    const reference = String(req.body?.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing payment reference." });

    // Already credited? Return the current state without touching the balance.
    const existing = await Transaction.findOne({ reference });
    if (existing) {
      return res.json({
        data: { agent: publicAgent(req.agent), transaction: existing, status: "success", alreadyCredited: true },
      });
    }

    const { ok, json } = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!ok || !json?.status) {
      return res.status(502).json({ error: json?.message || "Could not verify the payment." });
    }

    const data = json.data;
    if (data.status !== "success") {
      // e.g. "abandoned" / "failed" — nothing to credit.
      return res.json({ data: { status: data.status } });
    }

    // Guard: this payment must belong to the agent verifying it.
    const owner = data.metadata?.agentId;
    if (owner && owner !== String(req.agent._id)) {
      return res.status(403).json({ error: "This payment belongs to another account." });
    }

    const amount = money((data.amount || 0) / 100);
    req.agent.wallet = money(req.agent.wallet + amount);
    await req.agent.save();

    const transaction = await Transaction.create({
      agentId: req.agent._id,
      agent: req.agent.name,
      type: "topup",
      description: "Wallet top-up · Paystack",
      amount,
      reference,
    });

    res.status(201).json({ data: { agent: publicAgent(req.agent), transaction, status: "success" } });
  } catch (err) {
    next(err);
  }
});

export default router;
