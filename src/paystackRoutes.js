import { randomUUID } from "node:crypto";
import { Router } from "express";

import { Bundle, Payment } from "./models/index.js";
import { requireAuth } from "./lib/auth.js";
import { paystack, paystackConfigured, clientOrigin } from "./lib/paystackApi.js";
import { customerPaystackCharge, paystackFeePercent } from "./lib/paystackFee.js";
import { portalPurchaseEconomics } from "./lib/pricingPolicy.js";
import {
  netpluseLive,
  netpluseSimulatedSalesAllowed,
  netpluseWalletBalance,
  normalizePhone,
  resolveProviderBundle,
  validPhone,
} from "./lib/netpluseApi.js";
import {
  PaymentSettlementError,
  settleVerifiedPayment,
} from "./lib/paymentSettlement.js";

const router = Router();
router.use(requireAuth);

const money = (n) => Math.round(Number(n) * 100) / 100;
const maxTopup = () => Number(process.env.PAYSTACK_MAX_TOPUP_GHS) || 10000;

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function publicPortalPaymentStatus(payment) {
  const phone = String(payment.phone || "").replace(/\D/g, "");
  return {
    reference: payment.reference,
    status: payment.status,
    amount: money(payment.amount || 0),
    chargedAmount: money(payment.chargedAmount ?? payment.amount ?? 0),
    customerFee: money(payment.customerFee || 0),
    gatewayStatus: payment.gatewayStatus || "",
    order: payment.order || null,
    network: payment.network || "",
    gb: Number(payment.gb) || 0,
    recipient: phone ? `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : "",
    updatedAt: payment.updatedAt || null,
    failureReason: ["rejected", "refunded", "failed", "refund_failed"].includes(payment.status)
      ? payment.failureReason || ""
      : "",
  };
}

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
    const charge = customerPaystackCharge(amount);
    const chargedAmount = money(charge.totalSubunit / 100);
    const customerFee = money(charge.feeSubunit / 100);
    const callbackPath = req.agent.role === "superadmin" ? "/admin/add-fund" : "/agent/add-fund";
    const intent = await Payment.create({
      reference,
      purpose: "wallet_topup",
      amount,
      chargedAmount,
      customerFee,
      currency: "GHS",
      email: req.agent.email,
      agent: req.agent._id,
    });

    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: req.agent.email,
        amount: charge.totalSubunit,
        currency: "GHS",
        reference,
        callback_url: `${clientOrigin()}${callbackPath}`,
        metadata: {
          agentId: String(req.agent._id),
          purpose: "wallet_topup",
        },
      }),
    });
    if (!ok || !json?.status || !json?.data?.authorization_url) {
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

/** Start an authenticated portal purchase collected by the platform Paystack account. */
router.post("/purchase/init", async (req, res, next) => {
  try {
    const liveFulfilment = netpluseLive();
    if (!liveFulfilment && !netpluseSimulatedSalesAllowed()) {
      return res.status(503).json({ error: "Data delivery is temporarily unavailable." });
    }
    if (!paystackConfigured()) {
      return res.status(503).json({ error: "Mobile Money checkout is temporarily unavailable." });
    }
    if (!validEmail(req.agent.email)) {
      return res.status(409).json({
        error: "Your account needs a valid email before Mobile Money payments can be started.",
      });
    }

    const network = String(req.body?.network || "").trim();
    const gb = Number(req.body?.gb) || 0;
    const phone = normalizePhone(req.body?.phone || "");
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const isSuperadmin = req.agent.role === "superadmin";
    const [bundle, providerBundle] = await Promise.all([
      isSuperadmin
        ? Promise.resolve(null)
        : Bundle.findOne({ carrier: network, gb, active: true }).lean(),
      liveFulfilment || isSuperadmin
        ? resolveProviderBundle(network, gb)
        : Promise.resolve(null),
    ]);
    if (!isSuperadmin && !bundle) {
      return res.status(400).json({ error: "That bundle isn't available." });
    }
    if (isSuperadmin && !providerBundle) {
      return res.status(400).json({ error: "That bundle is not listed by Netpluse." });
    }

    if (liveFulfilment) {
      if (!providerBundle) {
        return res.status(503).json({ error: "That bundle is temporarily unavailable for delivery." });
      }
      const providerWallet = await netpluseWalletBalance();
      if (!providerWallet.ok) {
        return res.status(503).json({ error: "The delivery provider is temporarily unavailable." });
      }
      if (Number(providerWallet.balance) < Number(providerBundle.cost)) {
        return res.status(503).json({
          error: "That bundle cannot be delivered right now. Please try later.",
        });
      }
    }

    const platformPrice = money(bundle?.price ?? providerBundle?.cost ?? 0);
    const providerCost = money(providerBundle?.cost ?? bundle?.cost ?? 0);
    const { amount, agentMargin, platformMargin } = portalPurchaseEconomics({
      role: req.agent.role,
      platformPrice,
      providerCost,
    });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(409).json({ error: "This bundle does not have a valid checkout price." });
    }

    const reference = `DP-${randomUUID()}`;
    const charge = customerPaystackCharge(amount);
    const chargedAmount = money(charge.totalSubunit / 100);
    const customerFee = money(charge.feeSubunit / 100);
    const intent = await Payment.create({
      reference,
      provider: "paystack",
      purpose: "portal_order",
      status: "initialized",
      amount,
      chargedAmount,
      customerFee,
      currency: "GHS",
      email: req.agent.email,
      agent: req.agent._id,
      network,
      gb,
      phone,
      platformPrice,
      providerCost,
      agentMargin,
      platformMargin,
      paymentMethod: "momo",
      paymentDestination: "platform",
      verificationMode: "gateway",
      settlementModel: "platform_collected",
    });

    const callbackPath = isSuperadmin ? "/admin/buy-data" : "/agent/buy-data";
    const returnUrl = `${clientOrigin().replace(/\/$/, "")}${callbackPath}?payment_reference=${encodeURIComponent(reference)}`;
    const { ok, json } = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: req.agent.email,
        amount: charge.totalSubunit,
        currency: "GHS",
        reference,
        channels: ["mobile_money"],
        callback_url: returnUrl,
        metadata: {
          agentId: String(req.agent._id),
          purpose: "portal_order",
          settlementModel: "platform_collected",
          network,
          gb,
          phone,
        },
      }),
    });

    if (!ok || !json?.status || !json?.data?.authorization_url) {
      const failureReason = String(
        json?.data?.message || json?.message || "Could not open the secure Paystack checkout."
      );
      await Payment.updateOne(
        { _id: intent._id },
        { $set: { status: "failed", failureReason } }
      );
      return res.status(502).json({ error: failureReason });
    }

    await Payment.updateOne(
      { _id: intent._id },
      { $set: { gatewayStatus: "checkout_created" } }
    );
    return res.status(201).json({
      data: {
        mode: "paystack_redirect",
        reference,
        amount,
        fee: customerFee,
        chargedAmount,
        feePercent: paystackFeePercent(),
        currency: "GHS",
        status: "checkout_created",
        authorizationUrl: json.data.authorization_url,
        accessCode: json.data.access_code,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Verify and report an authenticated portal purchase after Paystack returns. */
router.get("/purchase/status/:reference", async (req, res, next) => {
  try {
    let payment = await Payment.findOne({
      reference: req.params.reference,
      purpose: "portal_order",
      agent: req.agent._id,
    }).lean();
    if (!payment) return res.status(404).json({ error: "Payment request not found." });

    const terminal = [
      "fulfilling",
      "fulfilled",
      "failed",
      "refunded",
      "refund_pending",
      "refund_failed",
    ];
    if (!terminal.includes(payment.status)) {
      if (!paystackConfigured()) {
        return res.status(503).json({ error: "Payment verification is temporarily unavailable." });
      }
      const { ok, json } = await paystack(
        `/transaction/verify/${encodeURIComponent(payment.reference)}`
      );
      if (ok && json?.status && json.data?.status === "success") {
        const settled = await settleVerifiedPayment(payment.reference, json.data);
        payment = settled.payment || payment;
      } else if (json?.data?.status) {
        const gatewayStatus = String(json.data.status);
        const terminalFailure = ["failed", "abandoned", "reversed"].includes(gatewayStatus);
        const update = {
          gatewayStatus,
          ...(terminalFailure
            ? {
                status: "failed",
                failureReason: String(
                  json.data?.message || "The Mobile Money payment was not completed."
                ),
              }
            : {}),
        };
        await Payment.updateOne({ _id: payment._id }, { $set: update });
        payment = { ...payment, ...update };
      }
    }

    return res.json({ data: publicPortalPaymentStatus(payment) });
  } catch (err) {
    if (err instanceof PaymentSettlementError) {
      return res.status(err.status).json({ error: err.message });
    }
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
