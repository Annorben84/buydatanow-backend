import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * An agent's own selling price for a platform bundle. The platform catalog
 * (Bundle, superadmin-managed) holds the price agents PAY; this holds what
 * the agent's customers pay on their storefront. Absent row = sell at the
 * platform price.
 */
const AgentPriceSchema = new Schema(
  {
    agent: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    carrier: { type: String, enum: ["MTN", "Telecel", "AirtelTigo"], required: true },
    gb: { type: Number, required: true },
    price: { type: Number, required: true },
  },
  { timestamps: true }
);

AgentPriceSchema.index({ agent: 1, carrier: 1, gb: 1 }, { unique: true });

export const AgentPrice = model("AgentPrice", AgentPriceSchema);
export default AgentPrice;
