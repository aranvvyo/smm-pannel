// ---------------------------------------------------------------------------
// Service price validity. Pure functions, no database access.
//
// Classifies a service's SELLING rate (what a customer pays per 1000) so the
// catalog and the admin panel can tell apart:
//   ok       — positive, and the price at the service minimum is at least 1 paise
//   review   — positive but suspiciously low (below REVIEW_RATE_RUPEES per 1000);
//              still orderable, but flagged for the admin to confirm
//   unorderable — positive, but rounds to ₹0.00 at the minimum quantity
//   invalid  — zero, negative, or not a number (a broken or missing provider price)
//
// Nothing here changes a price. Invalid and unorderable services are hidden
// from customers; the order path still refuses any non-positive total (see
// orderRouter BAD_PRICE), so this module only decides what is SHOWN.
// ---------------------------------------------------------------------------
import { priceFor } from './money.js';

export const REVIEW_RATE_RUPEES = 0.01; // below this per 1000 → admin review

// The rate a customer would pay: the provider cost for "no profit" accounts,
// the admin selling rate otherwise.
export function sellingRate(service, noProfit = false) {
  return Number(noProfit ? service.provider_rate : service.admin_rate);
}

export function assessServicePrice(service, { noProfit = false } = {}) {
  const rate = sellingRate(service, noProfit);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { status: 'invalid', reason: 'Price is zero, missing or negative. Check the provider rate and markup.' };
  }
  const min = Math.max(1, Math.floor(Number(service.min) || 1));
  if (priceFor(min, rate) <= 0) {
    return { status: 'unorderable', reason: `The price rounds to ₹0.00 at the minimum quantity (${min}).` };
  }
  if (rate < REVIEW_RATE_RUPEES) {
    return { status: 'review', reason: `Unusually low price (₹${rate} per 1000). Confirm it with the provider.` };
  }
  return { status: 'ok', reason: '' };
}

// Customer-facing rule: show only services that can actually be ordered.
export function isCustomerVisible(service, noProfit = false) {
  const { status } = assessServicePrice(service, { noProfit });
  return status === 'ok' || status === 'review';
}
