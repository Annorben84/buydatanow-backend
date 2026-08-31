const money = (value) => Math.round(Number(value) * 100) / 100;

/** Ordinary agents cannot sell below platform price; superadmins may override it. */
export function canSetSellingPrice(role, sellingPrice, platformPrice) {
  return role === "superadmin" || money(sellingPrice) >= money(platformPrice);
}

/** Superadmins buy at provider cost; agents keep their configured retail price. */
export function walletPurchasePrice({ role, providerCost, agentPrice, platformPrice }) {
  if (role === "superadmin") return money(providerCost);
  return money(agentPrice ?? platformPrice);
}

/** Agent markup earned when the Buy Data portal uses a configured selling price. */
export function agentBundleMargin({ role, agentPrice, platformPrice }) {
  if (role === "superadmin") return 0;
  const sellingPrice = money(agentPrice ?? platformPrice);
  return money(Math.max(0, sellingPrice - money(platformPrice)));
}

/** Complete wallet accounting for an agent-portal data purchase. */
export function walletPurchaseEconomics(options) {
  const amount = walletPurchasePrice(options);
  const agentMargin = agentBundleMargin(options);
  return {
    amount,
    agentMargin,
    // On provider failure, return the net amount charged after margin credit.
    refundAmount: money(amount - agentMargin),
  };
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
