import { randomUUID } from "node:crypto";
import { Router } from "express";

import { Payment } from "./models/index.js";
import { requireAuth } from "./lib/auth.js";
import { paystack, paystackConfigured, clientOrigin } from "./lib/paystackApi.js";
import {
  PaymentSettlementError,
  settleVerifiedPayment,
} from "./lib/paymentSettlement.js";

const router = Router();
router.use(requireAuth);

const money = (n) => Math.round(Number(n) * 100) / 100;
const maxTopup = () => Number(process.env.PAYSTACK_MAX_TOPUP_GHS) || 10000;

/** Start a server-recorded Paystack wallet top-up. */
router.post("/init", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Paystack is not configured." });
    }
    const amount = money(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 1 || amount > maxTopup()) {
      return res.status(400).json({
        error: `Enter an amount from ₵1 to ₵${maxTopup().toLocaleString()}.`,
      });
    }
    if (!req.agent.email) {
      return res.status(400).json({ error: "Your account needs an email to pay with Paystack." });
    }

    const reference = `DP-${randomUUID()}`;
    const intent = await Payment.create({
      reference,
      purpose: "wallet_topup",
      amount,
      currency: "GHS",
      email: req.agent.email,
      agent: req.agent._id,
    });

    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: req.agent.email,
        amount: Math.round(amount * 100),
        currency: "GHS",
        reference,
        callback_url: `${clientOrigin()}/agent/add-fund`,
        metadata: {
          agentId: String(req.agent._id),
          purpose: "wallet_topup",
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
        access_code: json.data.access_code,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Verify and atomically credit a Paystack top-up exactly once. */
router.post("/verify", async (req, res, next) => {
  try {
    if (!paystackConfigured()) {
      return res.status(500).json({ error: "Paystack is not configured." });
    }
    const reference = String(req.body?.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing payment reference." });

    const intent = await Payment.findOne({ reference, purpose: "wallet_topup" }).lean();
    if (!intent) return res.status(404).json({ error: "Payment intent not found." });
    if (String(intent.agent) !== String(req.agent._id)) {
      return res.status(403).json({ error: "This payment belongs to another account." });
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
        agent: result.agent,
        transaction: result.transaction,
        payment: result.payment,
        alreadyCredited: result.alreadySettled,
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
