import { Payment } from "../models/index.js";
import { paystack, paystackConfigured } from "./paystackApi.js";
import { PaymentSettlementError, settleVerifiedPayment } from "./paymentSettlement.js";
import { recordLog } from "./audit.js";

const pendingStatuses = ["initialized", "processing"];

/** Find only server-recorded, unsettled Paystack deposits. Old attempts rotate. */
export function pendingWalletTopups({ agentId, limit = 10, retryAfterMs = 0, minAgeMs = 0 } = {}) {
  return Payment.find({
    provider: "paystack",
    purpose: "wallet_topup",
    status: { $in: pendingStatuses },
    ...(agentId ? { agent: agentId } : {}),
    ...(minAgeMs ? { createdAt: { $lte: new Date(Date.now() - minAgeMs) } } : {}),
    ...(retryAfterMs ? {
      $or: [
        { lastVerifiedAt: null },
        { lastVerifiedAt: { $lte: new Date(Date.now() - retryAfterMs) } },
      ],
    } : {}),
  })
    .sort({ lastVerifiedAt: 1, createdAt: 1 })
    .limit(limit)
    .select("reference amount gatewayStatus")
    .lean();
}

/** Shared by browser verification and recovery; money moves only via settlement. */
export async function verifyWalletTopup(reference, { agentId } = {}) {
  const intent = await Payment.findOne({ reference, provider: "paystack", purpose: "wallet_topup" }).lean();
  if (!intent) throw new PaymentSettlementError("Payment intent not found.", 404);
  if (agentId && String(intent.agent) !== String(agentId)) {
    throw new PaymentSettlementError("This payment belongs to another account.", 403);
  }
  // A webhook may already have credited it. Return the saved credit even during
  // a Paystack outage, without requiring another gateway round trip.
  if (!pendingStatuses.includes(intent.status)) return settleVerifiedPayment(reference);
  if (!paystackConfigured()) throw new PaymentSettlementError("Paystack is not configured.", 503);

  const pendingFilter = { _id: intent._id, status: { $in: pendingStatuses } };
  await Payment.updateOne(pendingFilter, { $set: { lastVerifiedAt: new Date() } });
  const { ok, json } = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!ok || !json?.status) {
    throw new PaymentSettlementError(json?.message || "Could not verify the payment.", 502);
  }
  if (json.data?.status === "success") return settleVerifiedPayment(reference, json.data);

  const status = String(json.data?.status || "unknown");
  const updated = await Payment.updateOne(pendingFilter, { $set: { gatewayStatus: status } });
  // A slow pending response must not obscure a credit committed by a webhook.
  if (updated.matchedCount === 0) return settleVerifiedPayment(reference);
  return { status };
}

export async function syncPendingWalletTopups(options = {}) {
  if (!paystackConfigured()) return { checked: 0, credited: 0, errors: 0 };
  const pending = await pendingWalletTopups({ retryAfterMs: 90_000, minAgeMs: 60_000, ...options });
  const result = { checked: pending.length, credited: 0, errors: 0 };
  for (const payment of pending) {
    try {
      const settled = await verifyWalletTopup(payment.reference, { agentId: options.agentId });
      if (settled.status === "success" && !settled.alreadySettled) result.credited++;
    } catch (error) {
      result.errors++;
      await recordLog("error", "Wallet top-up recovery failed", "payments/recovery", {
        reference: payment.reference,
        error: error?.message || String(error),
      });
    }
  }
  return result;
}

let pollerTimer;

/** Always-on recovery. Serverless instances also recover when the wallet opens. */
export function startWalletTopupPoller() {
  const seconds = Number(process.env.PAYSTACK_POLL_SECONDS ?? 90);
  if (pollerTimer || !paystackConfigured() || !Number.isFinite(seconds) || seconds <= 0) return pollerTimer;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncPendingWalletTopups();
    } catch (error) {
      console.error("Wallet top-up recovery failed:", error?.message || error);
    } finally {
      running = false;
    }
  };
  void run();
  pollerTimer = setInterval(run, seconds * 1000);
  pollerTimer.unref?.();
  return pollerTimer;
}
