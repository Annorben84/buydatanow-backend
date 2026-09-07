import mongoose from "mongoose";

const schema = new mongoose.Schema({
  agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  readAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ agent: 1, createdAt: -1 });
schema.index({ agent: 1, readAt: 1 });

export const Notification = mongoose.model("Notification", schema);
