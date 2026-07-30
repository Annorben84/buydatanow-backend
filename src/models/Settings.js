import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Platform-wide settings — a single document (keyed "app"). The superadmin edits
 * these from /admin/settings; the brand/contact fields are read publicly so the
 * storefront and marketing site reflect them.
 */
const SettingsSchema = new Schema(
  {
    key: { type: String, default: "app", unique: true },

    // Brand & contact (public)
    appName: { type: String, default: "BuyDataNow", trim: true },
    tagline: { type: String, default: "Start your own data-selling business", trim: true },
    contactPhone: { type: String, default: "", trim: true },
    whatsapp: { type: String, default: "", trim: true },
    supportEmail: { type: String, default: "", trim: true, lowercase: true },
    address: { type: String, default: "", trim: true },

    // Operational toggles / fees (admin)
    maintenanceMode: { type: Boolean, default: false },
    allowSignups: { type: Boolean, default: true },
    autoApproveSmallFunds: { type: Boolean, default: true },
    transactionFeePct: { type: Number, default: 1.5 },
    withdrawalFee: { type: Number, default: 2.0 },
    whatsappAlerts: { type: Boolean, default: true },
    smsAlerts: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Settings = model("Settings", SettingsSchema);
export default Settings;
