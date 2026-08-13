const DEFAULT_FEE_PERCENT = 1.95;

/** Effective Paystack Ghana transaction rate (configurable for negotiated rates). */
export function paystackFeePercent() {
  const configured = Number(process.env.PAYSTACK_FEE_PERCENT ?? DEFAULT_FEE_PERCENT);
  return Number.isFinite(configured) && configured >= 0 && configured < 100
    ? configured
    : DEFAULT_FEE_PERCENT;
}

/**
 * Gross up a principal so the Paystack fee is paid by the customer.
 * Work in pesewas and return the smallest total whose rounded percentage fee
 * leaves at least the requested principal.
 */
export function customerPaystackCharge(principal) {
  const principalSubunit = Math.round(Number(principal) * 100);
  if (!Number.isSafeInteger(principalSubunit) || principalSubunit < 0) {
    throw new TypeError("Payment principal must be a non-negative amount.");
  }

  const rate = paystackFeePercent() / 100;
  if (rate === 0) {
    return { principalSubunit, feeSubunit: 0, totalSubunit: principalSubunit };
  }

  let totalSubunit = Math.ceil(principalSubunit / (1 - rate));
  const net = (total) => total - Math.round(total * rate);
  while (net(totalSubunit) < principalSubunit) totalSubunit += 1;
  while (totalSubunit > principalSubunit && net(totalSubunit - 1) >= principalSubunit) {
    totalSubunit -= 1;
  }

  return {
    principalSubunit,
    feeSubunit: totalSubunit - principalSubunit,
    totalSubunit,
  };
}
