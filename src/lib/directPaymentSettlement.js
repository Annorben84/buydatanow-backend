import { Agent, Order, Payment } from "../models/index.js";
import { publicAgent } from "./auth.js";
import { recordLog } from "./audit.js";
import { fulfilOrder } from "./fulfilment.js";
import { withMongoTransaction } from "./mongoTransaction.js";

const money = (value) => Math.round(Number(value) * 100) / 100;

export class DirectPaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DirectPaymentError";
    this.status = status;
  }
}

function directStatus(payment) {
  if (payment?.status === "fulfilled") return "fulfilled";
  if (payment?.status === "refunded") return "refunded";
  if (payment?.status === "rejected") return "rejected";
  if (["processing", "fulfilling"].includes(payment?.status)) return "processing";
  return payment?.status || "unknown";
}

/**
 * Book a verified storefront sale against the agent's prepaid wallet.
 * Customer money is outside the platform ledger: either the agent manually
 * confirmed it. Retained only for historical agent-direct payment claims;
 * new storefront checkouts use platform collection.
 */
export async function bookAgentWalletStorefrontOrder() {
  throw new DirectPaymentError(
    "Agent-funded storefront fulfilment is disabled. Contact platform support about this older payment.",
    410
  );
}

export async function dispatchAgentWalletOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return;
  try {
    await fulfilOrder(order);
  } catch (err) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { providerMessage: err?.message || "Fulfilment will be retried." } }
    );
    recordLog("error", `Direct-payment fulfilment interrupted · ${order.ref}`, "fulfilment", {
      error: err?.message || String(err),
    });
  }
}

/** Confirm a manual customer payment and book it exactly once. */
export async function settleDirectPayment(reference, confirmingAgentId) {
  const transactionResult = await withMongoTransaction(async (session) => {
    const intent = await Payment.findOne({
      reference,
      purpose: "storefront_order",
      provider: "agent_direct",
      agent: confirmingAgentId,
    }).session(session);

    if (!intent) throw new DirectPaymentError("Payment request not found.", 404);
    if (["processing", "fulfilling", "fulfilled", "refunded"].includes(intent.status)) {
      return { action: "existing", paymentId: intent._id, orderId: intent.order };
    }
    if (intent.status !== "awaiting_confirmation") {
      throw new DirectPaymentError(
        intent.status === "rejected"
          ? "This payment request was rejected."
          : "The customer has not submitted this payment for confirmation yet.",
        409
      );
    }

    const claimed = await Payment.findOneAndUpdate(
      { _id: intent._id, status: "awaiting_confirmation" },
      { $set: { status: "processing" } },
      { new: true, session }
    );
    if (!claimed) throw new DirectPaymentError("This payment is already being processed.", 409);

    return bookAgentWalletStorefrontOrder(claimed, session, { confirmedBy: confirmingAgentId });
  });

  if (transactionResult.action === "fulfil") {
    await dispatchAgentWalletOrder(transactionResult.orderId);
  }

  const payment = await Payment.findById(transactionResult.paymentId).lean();
  const [agent, order] = await Promise.all([
    payment?.agent ? Agent.findById(payment.agent) : null,
    payment?.order ? Order.findById(payment.order).lean() : null,
  ]);

  return {
    status: directStatus(payment),
    payment,
    agent: agent ? publicAgent(agent) : null,
    order,
    alreadySettled: transactionResult.action === "existing",
  };
}
