import mongoose from "mongoose";

const { Schema, model } = mongoose;

const StoreSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    // New storefront checkouts always use the platform Paystack account.
    // These payment fields remain so historical store records still deserialize.
    paymentMethod: {
      type: String,
      enum: ["momo", "bank_transfer"],
      default: "momo",
    },
    paymentProvider: { type: String, default: "Paystack", trim: true },
    paymentAccountName: { type: String, default: "", trim: true },
    paymentAccount: { type: String, default: "", trim: true },
    paymentInstructions: { type: String, default: "", trim: true, maxlength: 500 },
    momoProvider: { type: String, enum: ["", "mtn", "atl", "vod"], default: "" },
    // Deprecated subaccount metadata retained read-only for historical records.
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
