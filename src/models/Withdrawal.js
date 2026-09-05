import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * An agent's payout request. Commission is moved from available to held when
 * requested. Approval records the owner's external payment; rejection releases
 * the hold back to available commission.
 */
const WithdrawalSchema = new Schema(
  {
    agent: { type: Schema.Types.ObjectId, ref: "Agent", required: true, index: true },
    agentName: { type: String, default: "" },
    amount: { type: Number, required: true },
    method: { type: String, default: "" }, // e.g. "MTN MoMo", "Bank transfer"
    destination: { type: String, default: "" }, // account / phone number
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    payoutReference: { type: String, default: "" },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

export const Withdrawal = model("Withdrawal", WithdrawalSchema);
export default Withdrawal;
