import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Support ticket — a report submitted from the public/agent support center
 * (`POST /api/reports`). `reference` is the human-friendly tracking code
 * (DP-XXXXXX) shown to the reporter; `orderRef` is any order/transaction id
 * they included.
 */
const ReportSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: "", trim: true },
    phoneNormalized: { type: String, default: "", trim: true, index: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    orderRef: { type: String, default: "", trim: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    priority: { type: String, enum: ["Low", "Medium", "High"], default: "Medium" },
    status: { type: String, enum: ["Open", "Pending", "Resolved"], default: "Open" },
  },
  { timestamps: true }
);

export const Report = model("Report", ReportSchema);
export default Report;
