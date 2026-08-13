import { Order, Payment } from "./models/index.js";
import { validPaystackSignature } from "./lib/paystackApi.js";
import { settleVerifiedPayment } from "./lib/paymentSettlement.js";
import { recordLog } from "./lib/audit.js";

/** Signed Paystack webhook receiver for redirect-independent settlement. */
export async function paystackWebhook(req, res) {
  const signature = req.get("x-paystack-signature") || "";
  if (!validPaystackSignature(req.body, signature)) {
    return res.status(401).json({ error: "Invalid Paystack signature." });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid webhook payload." });
  }

  try {
    if (event.event === "charge.success") {
      const reference = String(event.data?.reference || "");
      if (reference) await settleVerifiedPayment(reference, event.data);
    } else if (String(event.event || "").startsWith("refund.")) {
      const transaction = event.data?.transaction;
      const reference = String(
        (typeof transaction === "object" ? transaction?.reference : "") ||
          event.data?.transaction_reference ||
          ""
      );
      const paystackId = String(
        (typeof transaction === "object" ? transaction?.id : transaction) || ""
      );
      if (!reference && !paystackId) return res.sendStatus(200);
      const payment = await Payment.findOne({
        $or: [
          ...(reference ? [{ reference }] : []),
          ...(paystackId ? [{ paystackId }] : []),
        ],
      }).lean();
      if (payment) {
        const rawStatus = String(event.data?.status || event.event.split(".")[1] || "pending");
        const status = rawStatus === "processed" ? "refunded" : rawStatus === "failed" ? "refund_failed" : "refund_pending";
        await Promise.all([
          Payment.updateOne({ _id: payment._id }, { $set: { status } }),
          Order.updateOne(
            { paymentReference: payment.reference },
            {
              $set: {
                "refund.status": rawStatus,
                "refund.providerRef": String(event.data?.id || ""),
                "refund.message": String(event.data?.reason || ""),
                "refund.updatedAt": new Date(),
              },
            }
          ),
        ]);
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    recordLog("error", `Paystack webhook failed · ${event.event}`, "payments/webhook", {
      error: err?.message || String(err),
    });
    return res.status(500).json({ error: "Webhook processing failed." });
  }
}
