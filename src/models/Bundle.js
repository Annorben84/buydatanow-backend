import mongoose from "mongoose";

const { Schema, model } = mongoose;

const BundleSchema = new Schema(
  {
    carrier: { type: String, enum: ["MTN", "Telecel", "AirtelTigo"], required: true },
    size: { type: String, required: true }, // e.g. "5 GB"
    gb: { type: Number, required: true },
    cost: { type: Number, default: 0 }, // platform base cost
    price: { type: Number, required: true }, // retail price
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

BundleSchema.index({ carrier: 1, gb: 1 }, { unique: true });

export const Bundle = model("Bundle", BundleSchema);
export default Bundle;
