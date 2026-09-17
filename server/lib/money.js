// Finance helpers. All money stored as integer subunits:
//   INR paise (₹1 = 100), USD cents ($1 = 100).
// PRICE / coupon math lives SERVERSIDE ONLY. The client receives computed
// final prices, never provider costs or markup breakdowns.

export const usdToInr = (cents, rate) => Math.ceil(cents * rate);   // paise
export const inrToUsd = (paise, rate) => Math.round(paise / rate);  // cents

export function fmtInr(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtUsd(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// raw quantity × rate-per-1000. Returns INR **paise** (₹1 = 100) so it matches
// the wallet/ledger storage unit.
export function priceFor(qty, ratePer1000) {
  return Math.round(qty * (Number(ratePer1000) / 1000) * 100);
}

// --------------------------------------------------------------------
// Coupon logic. The no-loss clamp is a hard server-side guarantee:
// final price can never fall below provider base cost.
//   base = provider cost for this qty
//   price = pre-coupon sale price for this qty
//   discount requested (percent or fixed) clamped to price - base
// --------------------------------------------------------------------
export function clampDiscount(requestedDiscount, price, base) {
  const maxDiscount = Math.max(0, price - base);
  return Math.min(requestedDiscount, maxDiscount);
}

/**
 * Compute the final price for a service/quantity/coupon combination.
 * Returns { price, discount, final } where final = price - discount, and
 * guarantees final >= base (no-loss).
 * coupon: {type:'percent'|'fixed_inr', value} | null
 */
export function computePricing({ qty, adminRate, baseRate, noProfit = false, coupon = null }) {
  const sellRate = noProfit ? baseRate : adminRate;
  const base = priceFor(qty, baseRate);
  const price = priceFor(qty, sellRate);
  let discount = 0;
  if (coupon) {
    const requested = coupon.type === 'percent'
      ? Math.round((price * coupon.value) / 100)
      : Math.round(coupon.value); // fixed_inr already paise
    discount = clampDiscount(requested, price, base);
  }
  return { base, price, discount, final: price - discount, sellRate, noProfit };
}

// Selling-rate derivation from provider base rate + markup config.
// percent: admin_rate = round(provider_rate * (1 + pct/100))
// fixed:   admin_rate = round(provider_rate) + fixedPaisePer1000  (value stored in paise)
export function applyMarkup(providerRate, markupType, markupValue) {
  if (markupType === 'fixed') {
    return Math.round(providerRate + markupValue);
  }
  return Math.round(providerRate * (1 + markupValue / 100));
}