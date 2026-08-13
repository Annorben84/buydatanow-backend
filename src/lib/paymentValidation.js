const asText = (value) => String(value ?? "");

/**
 * Verify a successful Paystack response against our immutable server intent.
 * Returns an error sentence, or an empty string when every critical field
 * matches. No client-supplied amount or bundle detail is trusted here.
 */
export function paymentMismatch(intent, data) {
  if (!data || data.status !== "success") return "Paystack has not confirmed a successful payment.";
  if (asText(data.reference) !== asText(intent.reference)) return "Payment reference mismatch.";

  const expectedSubunit = Math.round(Number(intent.chargedAmount ?? intent.amount) * 100);
  if (!Number.isSafeInteger(Number(data.amount)) || Number(data.amount) !== expectedSubunit) {
    return "Payment amount mismatch.";
  }
  if (asText(data.currency).toUpperCase() !== asText(intent.currency || "GHS").toUpperCase()) {
    return "Payment currency mismatch.";
  }

  const metadata = data.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "Payment metadata is missing.";
  }
  if (asText(metadata.purpose) !== asText(intent.purpose)) return "Payment purpose mismatch.";
  if (asText(metadata.agentId) !== asText(intent.agent)) return "Payment account mismatch.";

  if (intent.purpose === "storefront_order") {
    if (asText(metadata.storeSlug).toLowerCase() !== asText(intent.storeSlug).toLowerCase()) {
      return "Payment store mismatch.";
    }
    if (asText(metadata.network) !== asText(intent.network)) return "Payment network mismatch.";
    if (Number(metadata.gb) !== Number(intent.gb)) return "Payment bundle mismatch.";
    if (asText(metadata.phone) !== asText(intent.phone)) return "Payment recipient mismatch.";
  }

  return "";
}
