import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Immutable, server-created checkout intent plus its settlement state.
 *
 * Paystack metadata is useful for tracing, but it is not our source of truth.
 * The amount and purchase details captured here are what verification must
 * match before any wallet credit or data fulfilment can happen.
 */
const PaymentSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    provider: { type: String, enum: ["paystack", "agent_direct"], default: "paystack" },
    purpose: { type: String, enum: ["wallet_topup", "storefront_order"], required: true },
    status: {
      type: String,
      enum: [
        "initialized",
        "awaiting_payment",
        "awaiting_confirmation",
        "processing",
        "succeeded",
        "fulfilling",
        "fulfilled",
        "failed",
        "refund_pending",
        "refund_failed",
        "refunded",
        "rejected",
      ],
      default: "initialized",
      index: true,
    },
    // `amount` is the product/top-up principal. For Paystack wallet top-ups,
    // `chargedAmount` includes the customer-paid gateway fee. Direct storefront
    // payments have no platform charge, so the two amounts are equal.
    amount: { type: Number, required: true },
    chargedAmount: { type: Number },
    customerFee: { type: Number, default: 0 },
    currency: { type: String, default: "GHS" },
    email: { type: String, default: "" },
    payerName: { type: String, default: "" },
    customerReference: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    paymentDestination: { type: String, default: "" },
    verificationMode: {
      type: String,
      enum: ["gateway", "agent_confirmation"],
      default: "gateway",
    },
    settlementModel: {
      type: String,
      enum: ["platform_collected", "agent_wallet_debit"],
      default: "platform_collected",
    },
    momoProvider: { type: String, enum: ["", "mtn", "atl", "vod"], default: "" },
    momoPhone: { type: String, default: "" },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "Agent" },
    confirmedAt: { type: Date },
    agent: { type: Schema.Types.ObjectId, ref: "Agent", required: true, index: true },
    store: { type: Schema.Types.ObjectId, ref: "Store" },
    storeSlug: { type: String, default: "" },
    network: { type: String, enum: ["", "MTN", "Telecel", "AirtelTigo"], default: "" },
    gb: { type: Number, default: 0 },
    phone: { type: String, default: "" },
    platformPrice: { type: Number, default: 0 },
    providerCost: { type: Number, default: 0 },
    agentMargin: { type: Number, default: 0 },
    platformMargin: { type: Number, default: 0 },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    paystackId: { type: String, default: "" },
    gatewayFee: { type: Number, default: 0 },
    gatewayStatus: { type: String, default: "" },
    gatewayChannel: { type: String, default: "" },
    failureReason: { type: String, default: "" },
    settledAt: { type: Date },
  },
  { timestamps: true }
);

// A provider receipt may be claimed only once per agent. This prevents the
// same MoMo/bank transaction ID from funding multiple storefront orders.
PaymentSchema.index(
  { agent: 1, customerReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      provider: "agent_direct",
      customerReference: { $type: "string", $gt: "" },
    },
  }
);

export const Payment = model("Payment", PaymentSchema);
export default Payment;
