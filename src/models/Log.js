import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Platform audit-log entry. Records notable events (admin sign-ins, account
 * suspensions, role changes, withdrawal decisions, …) so the superadmin has a
 * real event stream on the Platform Logs page. Written via `recordLog()`.
 */
const LogSchema = new Schema(
  {
    level: { type: String, enum: ["error", "warning", "info"], default: "info" },
    message: { type: String, required: true, trim: true },
    source: { type: String, default: "system", trim: true },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const Log = model("Log", LogSchema);
export default Log;
