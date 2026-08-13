import { Order, Payment } from "../models/index.js";
import { paystack } from "./paystackApi.js";
import { recordLog } from "./audit.js";

/** Refund a successful payment that failed verification before an order existed. */
export async function requestPaystackRefundForPayment(payment, reason) {
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $nin: ["refund_pending", "refunded"] } },
    { $set: { status: "refund_pending", failureReason: reason } },
    { new: true }
  );
  if (!claimed) return { requested: false, status: payment.status };

  const { ok, json, transportError } = await paystack("/refund", {
    method: "POST",
    body: JSON.stringify({
      transaction: payment.reference,
      amount: Math.round(Number(payment.chargedAmount ?? payment.amount) * 100),
      currency: payment.currency || "GHS",
      customer_note: "This payment could not be safely matched to your checkout.",
      merchant_note: `Automatic refund: ${reason}`,
    }),
  });
  if (!ok || !json?.status) {
    const message = json?.message || "Could not request the Paystack refund.";
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: transportError ? "refund_pending" : "refund_failed", failureReason: message } }
    );
    recordLog("error", `Paystack unmatched-payment refund failed · ${payment.reference} · ${message}`, "payments/refunds");
    return { requested: false, status: transportError ? "unknown" : "failed", message };
  }

  const providerStatus = String(json.data?.status || "pending");
  const completed = ["processed", "success", "completed"].includes(providerStatus.toLowerCase());
  await Payment.updateOne(
    { _id: payment._id },
    { $set: { status: completed ? "refunded" : "refund_pending" } }
  );
  recordLog("warning", `Paystack unmatched payment refund queued · ${payment.reference}`, "payments/refunds");
  return { requested: true, status: providerStatus };
}

/** Queue one full customer refund. The Payment claim prevents duplicate calls. */
export async function requestPaystackRefundForOrder(order, reason = "Data order could not be fulfilled") {
  if (!order?.paymentReference) return { requested: false, status: "not-applicable" };

  const payment = await Payment.findOneAndUpdate(
    {
      reference: order.paymentReference,
      status: { $nin: ["refund_pending", "refunded"] },
    },
    {
      $set: {
        status: "refund_pending",
        failureReason: reason,
      },
    },
    { new: true }
  );

  // Another request already claimed or completed this refund.
  if (!payment) {
    const existing = await Payment.findOne({ reference: order.paymentReference }).lean();
    return { requested: false, status: existing?.status || "unknown" };
  }

  const now = new Date();
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        "refund.status": "requesting",
        "refund.message": reason,
        "refund.updatedAt": now,
      },
    }
  );

  const { ok, json, transportError } = await paystack("/refund", {
    method: "POST",
    body: JSON.stringify({
      transaction: order.paymentReference,
      amount: Math.round(Number(payment.chargedAmount ?? payment.amount) * 100),
      currency: "GHS",
      customer_note: "Your data order could not be delivered.",
      merchant_note: `Automatic refund for undelivered order ${order.ref}`,
    }),
  });

  if (!ok || !json?.status) {
    // A transport failure is ambiguous: the provider may have accepted the
    // request. Keep it pending for support reconciliation instead of retrying
    // automatically and risking a duplicate refund.
    const status = transportError ? "unknown" : "failed";
    const message = json?.message || "Could not request the Paystack refund.";
    await Promise.all([
      Order.updateOne(
        { _id: order._id },
        { $set: { "refund.status": status, "refund.message": message, "refund.updatedAt": new Date() } }
      ),
      Payment.updateOne(
        { _id: payment._id },
        { $set: { status: transportError ? "refund_pending" : "refund_failed", failureReason: message } }
      ),
    ]);
    recordLog("error", `Paystack refund ${status} · ${order.ref} · ${message}`, "payments/refunds");
    return { requested: false, status, message };
  }

  const refund = json.data || {};
  const providerStatus = String(refund.status || "pending");
  const completed = ["processed", "success", "completed"].includes(providerStatus.toLowerCase());
  await Promise.all([
    Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "refund.status": providerStatus,
          "refund.providerRef": String(refund.id || ""),
          "refund.message": json.message || "Refund queued.",
          "refund.requestedAt": now,
          "refund.updatedAt": new Date(),
        },
      }
    ),
    Payment.updateOne(
      { _id: payment._id },
      { $set: { status: completed ? "refunded" : "refund_pending" } }
    ),
  ]);
  recordLog("warning", `Paystack refund queued · ${order.ref} · ₵${payment.chargedAmount ?? payment.amount}`, "payments/refunds", {
    refundId: refund.id,
    status: providerStatus,
  });
  return { requested: true, status: providerStatus, providerRef: refund.id };
}
