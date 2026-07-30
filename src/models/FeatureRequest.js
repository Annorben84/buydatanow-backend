import mongoose from "mongoose";

const { Schema, model } = mongoose;

/** An idea submitted by an agent via the "Request a Feature" form. */
const FeatureRequestSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, default: "Other", trim: true },
    description: { type: String, default: "", trim: true },
    by: { type: String, default: "Anonymous", trim: true },
    votes: { type: Number, default: 1 },
    status: { type: String, enum: ["Open", "Planned", "Shipped"], default: "Open" },
  },
  { timestamps: true }
);

export const FeatureRequest = model("FeatureRequest", FeatureRequestSchema);
export default FeatureRequest;
