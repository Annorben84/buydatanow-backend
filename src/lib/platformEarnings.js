const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/** Trusted ledger amounts released after a platform-collected order is delivered. */
export function platformCollectedEarnings({
  agentMargin,
  platformMargin,
  chargedAmount,
  principal,
  gatewayFee,
}) {
  const commission = money(Math.max(0, Number(agentMargin) || 0));
  const margin = money(platformMargin);
  const feeRecovery = money(Math.max(0, Number(chargedAmount || 0) - Number(principal || 0)));
  const fee = money(Math.max(0, Number(gatewayFee) || 0));
  return {
    agentCommission: commission,
    platformMargin: margin,
    feeRecovery,
    gatewayFee: fee,
    platformNet: money(margin + feeRecovery - fee),
  };
}
