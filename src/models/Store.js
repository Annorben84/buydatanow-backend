import mongoose from "mongoose";

const { Schema, model } = mongoose;

const StoreSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
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
