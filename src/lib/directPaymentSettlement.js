import { Agent, Customer, Order, Payment, Store, Transaction } from "../models/index.js";
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
 * confirmed it, or Paystack routed it to the agent's subaccount.
 */
export async function bookAgentWalletStorefrontOrder(claimed, session, options = {}) {
  const [store, owner] = await Promise.all([
    Store.findOne({ _id: claimed.store, agent: claimed.agent }).session(session),
    Agent.findOne({ _id: claimed.agent, status: "active" }).session(session),
  ]);
  if (!store || !owner || store.status !== "active") {
    throw new DirectPaymentError("This storefront is not available for fulfilment.", 409);
  }

  const walletDebit = money(claimed.platformPrice);
  const debitedAgent = await Agent.findOneAndUpdate(
    { _id: owner._id, wallet: { $gte: walletDebit } },
    { $inc: { wallet: -walletDebit } },
    { new: true, session }
  );
  if (!debitedAgent) {
    throw new DirectPaymentError(
      `Insufficient wallet balance. Add at least GH₵${walletDebit.toFixed(2)} to fulfil this sale.`,
      402
    );
  }

  const superadmin = await Agent.findOne({ role: "superadmin" })
    .sort({ createdAt: 1 })
    .session(session);

  const customerResult = await Customer.updateOne(
    { agent: owner._id, phone: claimed.phone },
    {
      $setOnInsert: { name: claimed.payerName || claimed.phone },
      $set: { store: store.name },
      $inc: { orders: 1, spent: claimed.amount },
    },
    { upsert: true, session }
  );
  const newCustomer = Boolean(customerResult.upsertedCount);

  const [order] = await Order.create(
    [
      {
        agent: owner._id,
        ref: claimed.reference,
        store: store.name,
        customer: claimed.payerName || claimed.phone,
        phone: claimed.phone,
        carrier: claimed.network,
        bundle: `${claimed.gb} GB`,
        gb: claimed.gb,
        amount: claimed.amount,
        earning: claimed.agentMargin,
        platformEarning: claimed.platformMargin,
        status: "pending",
        paymentProvider: claimed.provider,
        paymentReference: claimed.reference,
        reversal: {
          agent: owner._id,
          agentName: owner.name,
          agentWalletAdjustment: walletDebit,
          platformWalletAdjustment: superadmin ? money(-claimed.platformMargin) : 0,
          storeId: store._id,
          newCustomer,
        },
      },
    ],
    { session, ordered: true }
  );

  await Transaction.create(
    [
      {
        agentId: owner._id,
        agent: owner.name,
        store: store.name,
        type: "purchase",
        description: `Store fulfilment · ${claimed.network} ${claimed.gb}GB`,
        amount: -walletDebit,
        reference: `${claimed.reference}-wallet-debit`,
      },
    ],
    { session, ordered: true }
  );

  if (superadmin && claimed.platformMargin !== 0) {
    await Agent.updateOne(
      { _id: superadmin._id },
      { $inc: { wallet: claimed.platformMargin } },
      { session }
    );
    await Transaction.create(
      [
        {
          agentId: superadmin._id,
          agent: superadmin.name,
          store: store.name,
          type: claimed.platformMargin > 0 ? "commission" : "fee",
          description: `Platform commission · ${store.name} · ${claimed.network} ${claimed.gb}GB`,
          amount: claimed.platformMargin,
          reference: `${claimed.reference}-platform`,
        },
      ],
      { session, ordered: true }
    );
  }

  await Store.updateOne(
    { _id: store._id },
    {
      $inc: {
        orders: 1,
        revenue: claimed.amount,
        customers: newCustomer ? 1 : 0,
      },
    },
    { session }
  );

  claimed.status = "fulfilling";
  claimed.order = order._id;
  claimed.settledAt = new Date();
  if (options.confirmedBy) {
    claimed.confirmedBy = options.confirmedBy;
    claimed.confirmedAt = new Date();
  }
  await claimed.save({ session });

  return { action: "fulfil", paymentId: claimed._id, agentId: owner._id, orderId: order._id };
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
