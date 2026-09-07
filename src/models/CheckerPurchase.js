import mongoose from "mongoose";

const schema = new mongoose.Schema({
  agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },
  reference: { type: String, required: true, unique: true },
  clientReference: { type: String, required: true },
  providerReference: { type: String, default: "" },
  type: { type: String, enum: ["waec", "bece"], required: true },
  quantity: { type: Number, min: 1, max: 50, required: true },
  unitPrice: { type: Number, required: true },
  amount: { type: Number, required: true },
  providerCost: { type: Number, required: true },
  isSuperadmin: { type: Boolean, default: false },
  channel: { type: String, enum: ["wallet", "public"], default: "wallet" },
  paymentReference: { type: String, default: "" },
  agentMargin: { type: Number, default: 0 },
  status: { type: String, enum: ["pending", "processing", "completed", "refunded", "refund_pending"], default: "pending" },
  providerStatus: { type: String, default: "" },
  // Excluded from ordinary queries, history, and logs. Only the buyer's detail route reveals PINs.
  pins: { type: [{ _id: false, serial: String, pin: String, expires: String }], select: false, default: [] },
  message: { type: String, default: "" },
  dispatchedAt: { type: Date, default: null },
  nextSyncAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: "" },
  settledAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ agent: 1, clientReference: 1 }, { unique: true });
schema.index({ agent: 1, createdAt: -1 });
schema.index({ status: 1, nextSyncAt: 1 });
export const CheckerPurchase = mongoose.model("CheckerPurchase", schema);
