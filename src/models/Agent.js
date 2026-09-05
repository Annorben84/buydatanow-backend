import mongoose from "mongoose";

const { Schema, model } = mongoose;

const AgentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "", trim: true, lowercase: true },
    // Never returned by default (must be explicitly `.select("+passwordHash")`).
    passwordHash: { type: String, select: false },
    wallet: { type: Number, default: 0 },
    // Storefront commission becomes available only after confirmed delivery.
    // Agents may either move it to their wallet or place it on hold for payout.
    commissionAvailable: { type: Number, default: 0, min: 0 },
    commissionHeld: { type: Number, default: 0, min: 0 },
    revenue: { type: Number, default: 0 },
    tier: { type: String, enum: ["Bronze", "Silver", "Gold"], default: "Bronze" },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    // Platform role — "superadmin" unlocks the /admin console and admin APIs.
    role: { type: String, enum: ["agent", "superadmin"], default: "agent" },
    // Optional reseller hierarchy. Null means this is a direct platform agent.
    parentAgent: { type: Schema.Types.ObjectId, ref: "Agent", default: null, index: true },
    discount: { type: Number, min: 0, max: 100, default: 0 },
  },
  { timestamps: true }
);

// Unique email, but only for real (non-empty) emails — seed agents use "".
AgentSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string", $gt: "" } } }
);

// Belt-and-braces: never leak the hash if a doc is ever serialized directly.
AgentSchema.set("toJSON", {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

export const Agent = model("Agent", AgentSchema);
export default Agent;
