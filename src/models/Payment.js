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
    provider: { type: String, enum: ["paystack"], default: "paystack" },
    purpose: { type: String, enum: ["wallet_topup", "storefront_order"], required: true },
    status: {
      type: String,
      enum: [
        "initialized",
        "processing",
        "succeeded",
        "fulfilling",
        "fulfilled",
        "failed",
        "refund_pending",
        "refund_failed",
        "refunded",
      ],
      default: "initialized",
      index: true,
    },
    // `amount` is the product/top-up principal. `chargedAmount` includes the
    // customer-paid Paystack fee and is what gateway verification must match.
    amount: { type: Number, required: true },
    chargedAmount: { type: Number },
    customerFee: { type: Number, default: 0 },
    currency: { type: String, default: "GHS" },
    email: { type: String, default: "" },
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
    failureReason: { type: String, default: "" },
    settledAt: { type: Date },
  },
  { timestamps: true }
);

export const Payment = model("Payment", PaymentSchema);
export default Payment;
