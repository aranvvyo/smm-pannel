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

// Rates are RUPEES per 1000 units and are routinely fractional (₹0.45 per
// 1000 is a normal SMM rate). They must never be rounded to whole rupees:
// Math.round(0.45) === 0 turned valid cheap services into ₹0.00 prices.
// Rates are kept to 4 decimal places (sub-paisa precision is retained in
// storage; money amounts are rounded to paise only when an order total is
// computed, in priceFor).
export function normalizeRate(rate) {
  return Math.round(Number(rate) * 10000) / 10000;
}

// Selling-rate derivation from provider base rate + markup config.
// percent: admin_rate = provider_rate * (1 + pct/100)
// fixed:   admin_rate = provider_rate + markupValue  (rupees per 1000)
export function applyMarkup(providerRate, markupType, markupValue) {
  if (markupType === 'fixed') {
    return normalizeRate(Number(providerRate) + Number(markupValue));
  }
  return normalizeRate(Number(providerRate) * (1 + Number(markupValue) / 100));
}

// Client-facing "price per 1000" in rupees. Must NOT be rounded to a whole
// rupee — see normalizeRate. Display formatting (fmtInr) handles paise.
export function displayRatePer1k(rate) {
  return normalizeRate(rate);
}