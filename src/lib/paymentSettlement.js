import {
  Agent,
  Customer,
  Order,
  Payment,
  Store,
  Transaction,
} from "../models/index.js";
import { publicAgent } from "./auth.js";
import { fulfilOrder } from "./fulfilment.js";
import { withMongoTransaction } from "./mongoTransaction.js";
import { requestPaystackRefundForPayment } from "./paystackRefund.js";
import { paymentMismatch } from "./paymentValidation.js";
import { recordLog } from "./audit.js";

const money = (n) => Math.round(Number(n) * 100) / 100;

export class PaymentSettlementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PaymentSettlementError";
    this.status = status;
  }
}

function publicStatus(payment) {
  if (["succeeded", "fulfilling", "fulfilled"].includes(payment.status)) return "success";
  if (payment.status === "refund_pending") return "refunding";
  if (payment.status === "refunded") return "refunded";
  if (payment.status === "refund_failed") return "refund_failed";
  return payment.gatewayStatus || payment.status;
}

/**
 * Atomically settle a Paystack success exactly once, then dispatch a newly
 * booked storefront order to Rema outside the database transaction.
 */
export async function settleVerifiedPayment(reference, gatewayData) {
  const transactionResult = await withMongoTransaction(async (session) => {
    const intent = await Payment.findOne({ reference }).session(session);
    if (!intent) {
      throw new PaymentSettlementError("This payment was not initialized by this platform.", 404);
    }

    if (intent.status === "failed" && gatewayData?.status === "success") {
      return {
        action: "mismatch",
        paymentId: intent._id,
        mismatch: intent.failureReason || "Payment could not be safely settled.",
      };
    }
    if (!["initialized", "processing"].includes(intent.status)) {
      return { action: "existing", paymentId: intent._id, agentId: intent.agent, orderId: intent.order };
    }

    const mismatch = paymentMismatch(intent, gatewayData);
    if (mismatch) {
      intent.status = gatewayData?.status === "success" ? "failed" : "initialized";
      intent.gatewayStatus = String(gatewayData?.status || "");
      intent.failureReason = mismatch;
      await intent.save({ session });
      return { action: "mismatch", paymentId: intent._id, mismatch };
    }

    const claimed = await Payment.findOneAndUpdate(
      { _id: intent._id, status: { $in: ["initialized", "processing"] } },
      {
        $set: {
          status: "processing",
          gatewayStatus: String(gatewayData.status),
          paystackId: String(gatewayData.id || ""),
          gatewayFee: money((Number(gatewayData.fees) || 0) / 100),
        },
      },
      { new: true, session }
    );
    if (!claimed) {
      const current = await Payment.findById(intent._id).session(session);
      return { action: "existing", paymentId: intent._id, agentId: current?.agent, orderId: current?.order };
    }

    const feeRecovery = money(
      Number(claimed.chargedAmount ?? claimed.amount) - Number(claimed.amount)
    );

    if (claimed.purpose === "wallet_topup") {
      const agent = await Agent.findByIdAndUpdate(
        claimed.agent,
        { $inc: { wallet: claimed.amount } },
        { new: true, session }
      );
      if (!agent) {
        claimed.status = "failed";
        claimed.failureReason = "The payment account no longer exists.";
        await claimed.save({ session });
        return { action: "mismatch", paymentId: claimed._id, mismatch: claimed.failureReason };
      }

      await Transaction.create(
        [
          {
            agentId: agent._id,
            agent: agent.name,
            type: "topup",
            description: "Wallet top-up · Paystack",
            amount: claimed.amount,
            reference: claimed.reference,
          },
        ],
        { session }
      );
      if (feeRecovery !== 0 || claimed.gatewayFee > 0) {
        const superadmin = await Agent.findOne({ role: "superadmin" })
          .sort({ createdAt: 1 })
          .session(session);
        if (superadmin) {
          const gatewayNet = money(feeRecovery - claimed.gatewayFee);
          await Agent.updateOne(
            { _id: superadmin._id },
            { $inc: { wallet: gatewayNet } },
            { session }
          );
          const gatewayRows = [];
          if (feeRecovery > 0) {
            gatewayRows.push(
              {
                agentId: superadmin._id,
                agent: superadmin.name,
                type: "fee",
                description: "Paystack fee paid by customer · wallet top-up",
                amount: feeRecovery,
                reference: `${claimed.reference}-paystack-fee-recovery`,
              }
            );
          }
          if (claimed.gatewayFee > 0) {
            gatewayRows.push(
              {
                agentId: superadmin._id,
                agent: superadmin.name,
                type: "fee",
                description: "Paystack fee · wallet top-up",
                amount: -claimed.gatewayFee,
                reference: `${claimed.reference}-paystack-fee`,
              }
            );
          }
          if (gatewayRows.length) await Transaction.create(gatewayRows, { session });
        }
      }
      claimed.status = "succeeded";
      claimed.settledAt = new Date();
      await claimed.save({ session });
      return { action: "wallet", paymentId: claimed._id, agentId: agent._id };
    }

    const store = await Store.findOne({ _id: claimed.store, agent: claimed.agent }).session(session);
    const agent = await Agent.findById(claimed.agent).session(session);
    if (!store || !agent) {
      claimed.status = "failed";
      claimed.failureReason = "This storefront is no longer connected to its owner.";
      await claimed.save({ session });
      return { action: "mismatch", paymentId: claimed._id, mismatch: claimed.failureReason };
    }

    const superadmin = await Agent.findOne({ role: "superadmin" })
      .sort({ createdAt: 1 })
      .session(session);

    const [order] = await Order.create(
      [
        {
          agent: agent._id,
          ref: claimed.reference,
          store: store.name,
          customer: claimed.phone,
          phone: claimed.phone,
          carrier: claimed.network,
          bundle: `${claimed.gb} GB`,
          gb: claimed.gb,
          amount: claimed.amount,
          earning: claimed.agentMargin,
          platformEarning: claimed.platformMargin,
          status: "pending",
          paymentProvider: "paystack",
          paymentReference: claimed.reference,
          reversal: {
            agent: agent._id,
            agentName: agent.name,
            agentWalletAdjustment: money(-claimed.agentMargin),
            platformWalletAdjustment: superadmin
              ? money(-(claimed.platformMargin + feeRecovery - claimed.gatewayFee))
              : 0,
            storeId: store._id,
          },
        },
      ],
      { session }
    );

    const customerResult = await Customer.updateOne(
      { agent: agent._id, phone: claimed.phone },
      {
        $setOnInsert: { name: claimed.phone },
        $set: { store: store.name },
        $inc: { orders: 1, spent: claimed.amount },
      },
      { upsert: true, session }
    );
    const newCustomer = Boolean(customerResult.upsertedCount);

    if (claimed.agentMargin > 0) {
      await Agent.updateOne(
        { _id: agent._id },
        { $inc: { wallet: claimed.agentMargin } },
        { session }
      );
      await Transaction.create(
        [
          {
            agentId: agent._id,
            agent: agent.name,
            store: store.name,
            type: "commission",
            description: `Sale margin · ${claimed.network} ${claimed.gb}GB`,
            amount: claimed.agentMargin,
            reference: `${claimed.reference}-margin`,
          },
        ],
        { session }
      );
    }

    if (superadmin) {
      const platformNet = money(claimed.platformMargin + feeRecovery - claimed.gatewayFee);
      if (platformNet !== 0) {
        await Agent.updateOne(
          { _id: superadmin._id },
          { $inc: { wallet: platformNet } },
          { session }
        );
      }
      if (claimed.platformMargin > 0) {
        await Transaction.create(
          [
            {
              agentId: superadmin._id,
              agent: superadmin.name,
              store: store.name,
              type: "commission",
              description: `Platform margin · ${store.name} · ${claimed.network} ${claimed.gb}GB`,
              amount: claimed.platformMargin,
              reference: `${claimed.reference}-platform`,
            },
          ],
          { session }
        );
      }
      if (feeRecovery > 0) {
        await Transaction.create(
          [
            {
              agentId: superadmin._id,
              agent: superadmin.name,
              store: store.name,
              type: "fee",
              description: `Paystack fee paid by customer · ${store.name} · ${claimed.network} ${claimed.gb}GB`,
              amount: feeRecovery,
              reference: `${claimed.reference}-paystack-fee-recovery`,
            },
          ],
          { session }
        );
      }
      if (claimed.gatewayFee > 0) {
        await Transaction.create(
          [
            {
              agentId: superadmin._id,
              agent: superadmin.name,
              store: store.name,
              type: "fee",
              description: `Paystack fee · ${store.name} · ${claimed.network} ${claimed.gb}GB`,
              amount: -claimed.gatewayFee,
              reference: `${claimed.reference}-paystack-fee`,
            },
          ],
          { session }
        );
      }
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
    await claimed.save({ session });
    return { action: "fulfil", paymentId: claimed._id, agentId: agent._id, orderId: order._id };
  });

  if (transactionResult.action === "mismatch") {
    const payment = await Payment.findById(transactionResult.paymentId);
    if (gatewayData?.status === "success" && payment) {
      await requestPaystackRefundForPayment(payment, transactionResult.mismatch);
    }
    throw new PaymentSettlementError(
      `${transactionResult.mismatch} The payment has been held for an automatic refund.`,
      409
    );
  }

  if (transactionResult.action === "fulfil") {
    const order = await Order.findById(transactionResult.orderId);
    if (order) {
      try {
        await fulfilOrder(order);
      } catch (err) {
        // The payment/order booking is already durable. Leave the order for the
        // recovery poller instead of returning an error that encourages a
        // customer to pay again.
        await Order.updateOne(
          { _id: order._id },
          { $set: { providerMessage: err?.message || "Fulfilment will be retried." } }
        );
        recordLog("error", `Fulfilment dispatch interrupted · ${order.ref}`, "fulfilment", {
          error: err?.message || String(err),
        });
      }
    }
  }

  const payment = await Payment.findById(transactionResult.paymentId).lean();
  const [agent, order, ledgerTransaction] = await Promise.all([
    payment?.agent ? Agent.findById(payment.agent) : null,
    payment?.order ? Order.findById(payment.order).lean() : null,
    payment?.purpose === "wallet_topup"
      ? Transaction.findOne({ reference: payment.reference }).lean()
      : null,
  ]);
  return {
    status: payment ? publicStatus(payment) : "processing",
    payment,
    agent: agent ? publicAgent(agent) : null,
    order,
    transaction: ledgerTransaction,
    alreadySettled: transactionResult.action === "existing",
  };
}
