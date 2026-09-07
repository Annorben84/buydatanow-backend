import mongoose from "mongoose";

const schema = new mongoose.Schema({
  agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },
  type: { type: String, enum: ["waec", "bece"], required: true },
  margin: { type: Number, min: 0, max: 1000, required: true },
}, { timestamps: true });
schema.index({ agent: 1, type: 1 }, { unique: true });
export const AgentCheckerMargin = mongoose.model("AgentCheckerMargin", schema);
