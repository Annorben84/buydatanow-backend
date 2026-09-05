const money = (value) => Math.round(Number(value) * 100) / 100;

/** Ordinary agents cannot sell below platform price; superadmins may override it. */
export function canSetSellingPrice(role, sellingPrice, platformPrice) {
  return role === "superadmin" || money(sellingPrice) >= money(platformPrice);
}

/** Superadmins pay provider cost; agents pay the platform catalog price. */
export function portalPurchasePrice({ role, providerCost, platformPrice }) {
  if (role === "superadmin") return money(providerCost);
  return money(platformPrice);
}

/** Trusted pricing for a Paystack purchase started from an authenticated portal. */
export function portalPurchaseEconomics(options) {
  const amount = portalPurchasePrice(options);
  return {
    amount,
    agentMargin: 0,
    platformMargin:
      options.role === "superadmin"
        ? 0
        : platformBundleMargin(options),
  };
}

/** Legacy shape retained for reading pre-Paystack wallet-order code. */
export function walletPurchaseEconomics(options) {
  const { amount, agentMargin } = portalPurchaseEconomics(options);
  return { amount, agentMargin, refundAmount: amount };
}

/** App-owner commission on a bundle sold through the agent purchase portal. */
export function platformBundleMargin({ platformPrice, providerCost }) {
  return money(Math.max(0, money(platformPrice) - money(providerCost)));
}

/** Split a storefront principal while charging a superadmin discount to the platform. */
export function storefrontMargins({ role, sellingPrice, platformPrice, providerCost }) {
  const selling = money(sellingPrice);
  const platform = money(platformPrice);
  const cost = money(providerCost);
  const isSuperadminDiscount = role === "superadmin" && selling < platform;

  return {
    agentMargin: isSuperadminDiscount ? 0 : money(Math.max(0, selling - platform)),
    platformMargin: isSuperadminDiscount
      ? money(selling - cost)
      : money(Math.max(0, platform - cost)),
  };
}
