import mongoose from "mongoose";

const { Schema, model } = mongoose;

const TransactionSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", index: true },
    type: {
      type: String,
      enum: [
        "purchase",
        "funding",
        "payout",
        "commission",
        "commission_transfer",
        "topup",
        "fee",
        "refund",
      ],
      required: true,
    },
    description: { type: String, default: "" },
    amount: { type: Number, default: 0 }, // signed
    agent: { type: String, default: "" },
    store: { type: String, default: "" },
    // Payment-gateway reference (e.g. Paystack). Unique when present so a
    // verified payment can only ever credit the wallet once (idempotency).
    reference: { type: String },
  },
  { timestamps: true }
);

TransactionSchema.index({ reference: 1 }, { unique: true, sparse: true });

export const Transaction = model("Transaction", TransactionSchema);
export default Transaction;
