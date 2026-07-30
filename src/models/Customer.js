import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CustomerSchema = new Schema(
  {
    agent: { type: Schema.Types.ObjectId, ref: "Agent", index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: "" },
    store: { type: String, default: "" },
    wallet: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Customer = model("Customer", CustomerSchema);
export default Customer;
