// ---------------------------------------------------------------------------
// INR deposit money math — integer paise only, never floating point.
//
// The 10% customer surcharge (GST) is added on top of the wallet credit:
//   credit ₹100  →  surcharge ₹10  →  customer pays ₹110
// The surcharge is separate from the wallet credit: a successful,
// server-verified payment always credits exactly the CREDIT amount, never
// the total the customer paid.
//
// This module is deliberately documentation-independent: it contains no
// gateway API knowledge (no endpoints, auth, webhook, or status model).
// It is the single source of truth for the INR deposit math used by the
// VCGetaway deposit page (client/src/pages/client/VcDeposit.jsx).
//
// No minimum deposit is imposed here — the gateway's minimum (if any) is
// unknown until its official API documentation is available.
// ---------------------------------------------------------------------------

// 10% customer surcharge, expressed in basis points (1000 bp = 10%).
export const SURCHARGE_BPS = 1000;

// Maximum single deposit request, in rupees. ₹1e9 = 1e11 paise —
// comfortably inside both JavaScript's safe-integer range and
// SQLite's 64-bit INTEGER, so every amount stays exact. Anything
// larger is rejected: past ~9.2e16 rupees the paise value would
// overflow SQLite's INTEGER, and long before that float rounding
// would silently corrupt the amount.
export const MAX_RUPEES = 1_000_000_000;

// Validate a customer-entered rupee amount and convert it to integer paise.
// Returns null for anything invalid (zero, negative, non-numeric, missing,
// non-finite, above the maximum); otherwise the credit in whole paise.
export function inrCreditPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RUPEES) return null;
  return Math.round(n * 100);
}

// The customer surcharge in integer paise.
export function inrSurchargePaise(creditPaise) {
  return Math.round((creditPaise * SURCHARGE_BPS) / 10000);
}

// The total the customer pays, in integer paise (credit + surcharge).
export function inrTotalPaise(creditPaise) {
  return creditPaise + inrSurchargePaise(creditPaise);
}
