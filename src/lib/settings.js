import { Settings } from "../models/index.js";

/** Get the single settings document, creating it with defaults on first use. */
export async function getSettings() {
  let doc = await Settings.findOne({ key: "app" });
  if (!doc) doc = await Settings.create({ key: "app" });
  return doc;
}

/** Fields safe to expose without auth (brand/contact + a couple of public flags). */
const PUBLIC_FIELDS = [
  "appName",
  "tagline",
  "contactPhone",
  "whatsapp",
  "supportEmail",
  "address",
  "maintenanceMode",
  "allowSignups",
];

export function publicSettings(doc) {
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = doc[f];
  return out;
}
