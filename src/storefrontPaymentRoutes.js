import { randomUUID } from "node:crypto";
import { Router } from "express";

import { Agent, AgentPrice, Bundle, Payment, Store } from "./models/index.js";
import { DirectPaymentError, settleDirectPayment } from "./lib/directPaymentSettlement.js";
import { requireAuth } from "./lib/auth.js";
import { clientOrigin, paystack, paystackConfigured } from "./lib/paystackApi.js";
import { customerPaystackCharge, paystackFeePercent } from "./lib/paystackFee.js";
import { PaymentSettlementError, settleVerifiedPayment } from "./lib/paymentSettlement.js";
import { canSetSellingPrice, storefrontMargins } from "./lib/pricingPolicy.js";
import {
  netpluseLive,
  netpluseSimulatedSalesAllowed,
  netpluseWalletBalance,
  normalizePhone,
  resolveProviderBundle,
  validPhone,
} from "./lib/netpluseApi.js";

const router = Router();
const money = (value) => Math.round(Number(value) * 100) / 100;

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function directPaymentDetails(store) {
  return {
    method: store.paymentMethod || "momo",
    provider: store.paymentProvider || "Mobile Money",
    accountName: store.paymentAccountName || store.name,
    account: store.paymentAccount || store.phone,
    instructions: store.paymentInstructions || "Use the order reference as the payment note.",
  };
}

function publicPaymentStatus(payment) {
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
    failureReason: ["rejected", "refunded", "failed"].includes(payment.status)
      ? payment.failureReason || ""
      : "",
  };
}

/** The unsafe legacy endpoint could spend an agent wallet without payment proof. */
router.post("/stores/slug/:slug/buy", (_req, res) => {
  res.status(410).json({
    error: "Direct purchases are disabled. Submit payment details for the store owner to confirm.",
  });
});

/**
 * Create an immutable direct-payment request. No customer money reaches the
 * platform and no wallet is touched at this stage.
 */
router.post("/stores/slug/:slug/pay/init", async (req, res, next) => {
  try {
    const liveFulfilment = netpluseLive();
    if (!liveFulfilment && !netpluseSimulatedSalesAllowed()) {
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
    const payerName = String(req.body.payerName || "").trim().slice(0, 100);
    if (!validPhone(phone)) {
      return res.status(400).json({ error: "Enter the phone number that should receive the data." });
    }

    const [bundle, owner, ownPrice] = await Promise.all([
      Bundle.findOne({ carrier: network, gb, active: true }).lean(),
      store.agent ? Agent.findOne({ _id: store.agent, status: "active" }).lean() : null,
      store.agent ? AgentPrice.findOne({ agent: store.agent, carrier: network, gb }).lean() : null,
    ]);
    if (!bundle) return res.status(400).json({ error: "That bundle isn't available." });
    if (!owner) return res.status(409).json({ error: "This store isn't ready to take orders yet." });

    const platformPrice = money(bundle.price);
    let providerCost = money(bundle.cost || 0);
    if (liveFulfilment) {
      const [providerBundle, providerWallet] = await Promise.all([
        resolveProviderBundle(network, gb),
        netpluseWalletBalance(),
      ]);
      if (!providerBundle) {
        return res.status(503).json({ error: "That bundle is temporarily unavailable for delivery." });
      }
      if (!providerWallet.ok) {
        return res.status(503).json({ error: "The delivery provider is temporarily unavailable." });
      }
      if (Number(providerWallet.balance) < Number(providerBundle.cost)) {
        return res.status(503).json({ error: "That bundle cannot be delivered right now. Please try later." });
      }
      providerCost = money(providerBundle.cost || bundle.cost || 0);
    }

    const amount = money(ownPrice?.price ?? platformPrice);
    if (!canSetSellingPrice(owner.role, amount, platformPrice)) {
      return res.status(409).json({ error: "This store's bundle price needs administrator review." });
    }
    if (money(owner.wallet) < platformPrice) {
      return res.status(409).json({
        error: "This store is temporarily unable to fulfil this bundle. Please contact the store owner.",
      });
    }

    const { agentMargin, platformMargin } = storefrontMargins({
      role: owner.role,
      sellingPrice: amount,
      platformPrice,
      providerCost,
    });
    const reference = `DP-${randomUUID()}`;

    if ((store.paymentMethod || "momo") === "momo") {
      if (!paystackConfigured()) {
        return res.status(503).json({ error: "Mobile Money checkout is temporarily unavailable." });
      }
      if (
        !/^ACCT_[A-Za-z0-9]+$/.test(String(store.paystackSubaccountCode || "")) ||
        !store.paystackSubaccountActive
      ) {
        return res.status(409).json({
          error: "This store has not connected its Paystack payment account yet.",
        });
      }

      const customerEmail = String(req.body.email || "").trim().toLowerCase();
      const email = customerEmail || String(owner.email || "").trim().toLowerCase();
      if (customerEmail && !validEmail(customerEmail)) {
        return res.status(400).json({ error: "Enter a valid email or leave the receipt email blank." });
      }
      if (!validEmail(email)) {
        return res.status(409).json({
          error: "This store needs a valid owner email before Mobile Money payments can be started.",
        });
      }

      const charge = customerPaystackCharge(amount);
      const chargedAmount = money(charge.totalSubunit / 100);
      const customerFee = money(charge.feeSubunit / 100);
      const intent = await Payment.create({
        reference,
        provider: "paystack",
        purpose: "storefront_order",
        status: "initialized",
        amount,
        chargedAmount,
        customerFee,
        currency: "GHS",
        email,
        payerName,
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
        paymentMethod: "momo",
        paymentDestination: store.paystackSubaccountCode,
        verificationMode: "gateway",
        settlementModel: "agent_wallet_debit",
      });

      const returnUrl = `${clientOrigin().replace(/\/$/, "")}/store/${encodeURIComponent(
        slug
      )}?payment_reference=${encodeURIComponent(reference)}`;
      const { ok, json } = await paystack("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email,
          amount: charge.totalSubunit,
          currency: "GHS",
          reference,
          channels: ["mobile_money"],
          callback_url: returnUrl,
          subaccount: store.paystackSubaccountCode,
          transaction_charge: 0,
          bearer: "subaccount",
          metadata: {
            agentId: String(owner._id),
            purpose: "storefront_order",
            storeSlug: slug,
            network,
            gb,
            phone,
          },
        }),
      });

      if (!ok || !json?.status) {
        const failureReason = String(
          json?.data?.message || json?.message || "Could not open the secure Paystack checkout."
        );
        await Payment.updateOne(
          { _id: intent._id },
          {
            $set: {
              status: "failed",
              failureReason,
            },
          }
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
    }

    const payment = directPaymentDetails(store);
    if (!payment.account) {
      return res.status(409).json({ error: "This store has not configured a customer payment account." });
    }
    await Payment.create({
      reference,
      provider: "agent_direct",
      purpose: "storefront_order",
      status: "awaiting_payment",
      amount,
      chargedAmount: amount,
      customerFee: 0,
      currency: "GHS",
      payerName,
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
      paymentMethod: payment.method,
      paymentDestination: payment.account,
      verificationMode: "agent_confirmation",
      settlementModel: "agent_wallet_debit",
    });

    res.status(201).json({
      data: {
        mode: "manual",
        reference,
        amount,
        currency: "GHS",
        status: "awaiting_payment",
        payment,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Customer supplies the provider transaction ID after paying the agent. */
router.post("/stores/slug/:slug/pay/submit", async (req, res, next) => {
  try {
    const reference = String(req.body.reference || "").trim();
    const customerReference = String(req.body.customerReference || "").trim().slice(0, 120);
    if (!reference) return res.status(400).json({ error: "Missing order reference." });
    if (customerReference.length < 4) {
      return res.status(400).json({ error: "Enter the transaction ID from your payment receipt." });
    }

    const payment = await Payment.findOneAndUpdate(
      {
        reference,
        purpose: "storefront_order",
        provider: "agent_direct",
        storeSlug: req.params.slug.toLowerCase(),
        status: "awaiting_payment",
      },
      { $set: { customerReference, status: "awaiting_confirmation" } },
      { new: true }
    );

    if (!payment) {
      const existing = await Payment.findOne({
        reference,
        provider: "agent_direct",
        storeSlug: req.params.slug.toLowerCase(),
      }).lean();
      if (!existing) return res.status(404).json({ error: "Payment request not found." });
      if (["awaiting_confirmation", "processing", "fulfilling", "fulfilled"].includes(existing.status)) {
        return res.json({ data: publicPaymentStatus(existing) });
      }
      return res.status(409).json({ error: `This payment request is ${existing.status}.` });
    }

    res.json({ data: publicPaymentStatus(payment) });
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.customerReference) {
      return res.status(409).json({ error: "That transaction ID has already been submitted." });
    }
    next(err);
  }
});

/** Minimal public status for a customer holding the unguessable order reference. */
router.get("/stores/slug/:slug/pay/status/:reference", async (req, res, next) => {
  try {
    let payment = await Payment.findOne({
      reference: req.params.reference,
      storeSlug: req.params.slug.toLowerCase(),
    }).lean();
    if (!payment) return res.status(404).json({ error: "Payment request not found." });

    if (
      payment.provider === "paystack" &&
      !["fulfilling", "fulfilled", "failed", "refunded", "refund_pending", "refund_failed"].includes(
        payment.status
      )
    ) {
      const { ok, json } = await paystack(
        `/transaction/verify/${encodeURIComponent(payment.reference)}`
      );
      if (ok && json?.status && json.data?.status === "success") {
        const settled = await settleVerifiedPayment(payment.reference, json.data);
        payment = settled.payment || payment;
      } else if (json?.data?.status) {
        const gatewayStatus = String(json.data.status);
        const terminalFailure = ["failed", "abandoned", "reversed"].includes(gatewayStatus);
        await Payment.updateOne(
          { _id: payment._id },
          {
            $set: {
              gatewayStatus,
              ...(terminalFailure
                ? {
                    status: "failed",
                    failureReason: String(json.data?.message || "The Mobile Money payment was not completed."),
                  }
                : {}),
            },
          }
        );
        payment = {
          ...payment,
          gatewayStatus,
          ...(terminalFailure
            ? {
                status: "failed",
                failureReason: String(json.data?.message || "The Mobile Money payment was not completed."),
              }
            : {}),
        };
      }
    }
    res.json({ data: publicPaymentStatus(payment) });
  } catch (err) {
    if (err instanceof PaymentSettlementError || err instanceof DirectPaymentError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

/** Legacy callbacks are replaced by signed webhooks plus the public status poll. */
router.post("/stores/slug/:slug/pay/verify", (_req, res) => {
  res.status(410).json({ error: "Use the payment status endpoint for this checkout." });
});

/** Only the signed-in store owner can confirm receipt and spend their wallet. */
router.post("/payments/:reference/confirm", requireAuth, async (req, res, next) => {
  try {
    const result = await settleDirectPayment(req.params.reference, req.agent._id);
    res.status(result.alreadySettled ? 200 : 201).json({
      data: {
        status: result.status,
        order: result.order,
        agent: result.agent,
        alreadySettled: result.alreadySettled,
      },
    });
  } catch (err) {
    if (err instanceof DirectPaymentError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

/** Rejecting a claim never touches the wallet or dispatches data. */
router.post("/payments/:reference/reject", requireAuth, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || "Payment not found in the agent account.")
      .trim()
      .slice(0, 300);
    const payment = await Payment.findOneAndUpdate(
      {
        reference: req.params.reference,
        provider: "agent_direct",
        agent: req.agent._id,
        status: "awaiting_confirmation",
      },
      { $set: { status: "rejected", failureReason: reason } },
      { new: true }
    );
    if (!payment) return res.status(409).json({ error: "This payment cannot be rejected now." });
    res.json({ data: publicPaymentStatus(payment) });
  } catch (err) {
    next(err);
  }
});

export default router;
