import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * An agent's payout request. Funds are HELD (deducted from the wallet) when
 * the request is created; approving logs the payout transaction, rejecting
 * refunds the wallet.
 */
const WithdrawalSchema = new Schema(
  {
    agent: { type: Schema.Types.ObjectId, ref: "Agent", required: true, index: true },
    agentName: { type: String, default: "" },
    amount: { type: Number, required: true },
    method: { type: String, default: "" }, // e.g. "MTN MoMo", "Bank transfer"
    destination: { type: String, default: "" }, // account / phone number
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

export const Withdrawal = model("Withdrawal", WithdrawalSchema);
export default Withdrawal;
