import mongoose from "mongoose";

const { Schema, model } = mongoose;

const StoreSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    // Customers pay this destination directly. The platform only verifies the
    // agent's confirmation and debits the agent's prepaid fulfilment wallet.
    paymentMethod: {
      type: String,
      enum: ["momo", "bank_transfer"],
      default: "momo",
    },
    paymentProvider: { type: String, default: "Mobile Money", trim: true },
    paymentAccountName: { type: String, default: "", trim: true },
    paymentAccount: { type: String, default: "", trim: true },
    paymentInstructions: { type: String, default: "", trim: true, maxlength: 500 },
    momoProvider: { type: String, enum: ["", "mtn", "atl", "vod"], default: "" },
    // Paystack routes MoMo collections straight to this agent-owned subaccount.
    // This is private configuration and must never be returned by public store APIs.
    paystackSubaccountCode: { type: String, default: "", trim: true },
    paystackSubaccountId: { type: String, default: "", trim: true },
    paystackSettlementName: { type: String, default: "", trim: true },
    paystackSubaccountActive: { type: Boolean, default: false },
    paystackSubaccountVerified: { type: Boolean, default: false },
    paystackSubaccountMode: { type: String, enum: ["", "test", "live"], default: "" },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    agent: { type: Schema.Types.ObjectId, ref: "Agent" },
    orders: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    customers: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Store = model("Store", StoreSchema);
export default Store;
