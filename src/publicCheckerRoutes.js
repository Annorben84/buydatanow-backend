import { Router } from "express";
import { Payment } from "./models/Payment.js";
import { CheckerPurchase } from "./models/CheckerPurchase.js";
import { publicCheckerCatalog, publicCheckerCatalogItem, initializePublicCheckerCheckout, hasCheckerAccess } from "./lib/publicCheckerCheckout.js";
import { paystack } from "./lib/paystackApi.js";
import { settleVerifiedPayment } from "./lib/paymentSettlement.js";
import { syncCheckerPurchase, refundPublicCheckerPurchase } from "./lib/checkerPurchases.js";

const router = Router();
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/", async (req, res, next) => {
  try {
    const catalog = await publicCheckerCatalog(typeof req.query.store === "string" ? req.query.store : "");
    res.json({ data: catalog.items.map(publicCheckerCatalogItem) });
  } catch (error) { next(error); }
});

router.post("/checkout", async (req, res, next) => {
  try { res.json({ data: await initializePublicCheckerCheckout(req.body) }); }
  catch (error) { next(error); }
});

router.get("/purchases/:reference", async (req, res, next) => {
  try {
    let payment = await Payment.findOne({ reference: req.params.reference, purpose: "checker_order" }).select("+checkerAccessHash");
    if (!payment || !hasCheckerAccess(payment, req.get("x-checker-key"))) return res.status(404).json({ error: "Purchase not found. Check your reference and recovery key." });
    if (["initialized", "processing"].includes(payment.status)) {
      const { ok, json } = await paystack(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
      if (ok && json?.status && json.data?.status === "success") {
        try { await settleVerifiedPayment(payment.reference, json.data); }
        catch (error) { if (error.status !== 409) throw error; }
      }
    }
    payment = await Payment.findById(payment._id);
    let purchase = payment.checkerPurchase ? await CheckerPurchase.findById(payment.checkerPurchase).select("+pins") : null;
    if (purchase) {
      try { await syncCheckerPurchase(purchase._id); } catch { /* Saved payment and PINs remain recoverable. */ }
      purchase = await CheckerPurchase.findById(purchase._id).select("+pins");
      if (purchase.status === "refund_pending") await refundPublicCheckerPurchase(purchase);
      payment = await Payment.findById(payment._id);
    }
    const status = ["refund_pending", "refund_failed", "refunded"].includes(payment.status)
      ? payment.status : purchase?.status || "awaiting_payment";
    res.json({ data: {
      reference: payment.reference, type: payment.checkerType, quantity: payment.checkerQuantity,
      amount: payment.amount, chargedAmount: payment.chargedAmount, customerFee: payment.customerFee,
      status, pins: purchase?.pins || [],
    } });
  } catch (error) { next(error); }
});

export default router;
