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

// There is NO business maximum on deposits. The only ceiling is an
// integer-precision guard: the surcharge is computed as credit × 1000
// (basis points), which stays exact only while that product is within
// Number.MAX_SAFE_INTEGER. Derived from that arithmetic, never shown to
// customers, and far above any real deposit. It is not a limit to display.
export const MAX_CREDIT_PAISE_EXACT = Math.floor(Number.MAX_SAFE_INTEGER / SURCHARGE_BPS);

// Validate a customer-entered rupee amount and convert it to integer paise.
// Accepts a plain decimal number or numeric string with at most two decimal
// places. Returns null for anything else: booleans, objects, empty, zero,
// negative, hex/exponent notation, more than 2 decimals (we never silently
// round money), or above the precision guard.
export function inrCreditPaise(rupees) {
  let s;
  if (typeof rupees === 'number') {
    if (!Number.isFinite(rupees)) return null;
    s = String(rupees);
  } else if (typeof rupees === 'string') {
    s = rupees.trim();
  } else {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [wholeStr, fracStr = ''] = s.split('.');
  const whole = Number(wholeStr);
  if (!Number.isSafeInteger(whole) || whole > Math.floor(MAX_CREDIT_PAISE_EXACT / 100)) return null;
  const paise = whole * 100 + Number(fracStr.padEnd(2, '0'));
  if (paise <= 0 || paise > MAX_CREDIT_PAISE_EXACT) return null;
  return paise;
}

// The customer surcharge in integer paise.
export function inrSurchargePaise(creditPaise) {
  return Math.round((creditPaise * SURCHARGE_BPS) / 10000);
}

// The total the customer pays, in integer paise (credit + surcharge).
export function inrTotalPaise(creditPaise) {
  return creditPaise + inrSurchargePaise(creditPaise);
}

// User-facing text for a failed deposit request. Takes the thrown API error
// ({ status, message }) and never shows internal detail. Specific server
// messages (e.g. "Deposit not found.", "Enter a valid deposit amount") are
// kept as-is; only generic or unknown failures are replaced.
export function depositErrorMessage(err) {
  if (!err) return 'Something went wrong. Please try again.';
  // A fetch that never reached the server (offline, DNS, CORS) has no status.
  if (err.status === undefined) return 'Network error. Check your connection and try again.';
  // The server's catch-all for unmatched /api paths. Reaching it means the
  // deposit service is not wired up, which is a genuine failure to report.
  if (err.status === 404 && (err.message === 'Not found.' || !err.message)) {
    return "The deposit service isn't available right now. Please try again shortly.";
  }
  if (err.status === 401 || err.status === 403) return 'Please sign in again to continue.';
  if (err.status >= 500) return 'Something went wrong on our side. Please try again shortly.';
  if (typeof err.message === 'string' && err.message && err.message !== 'Request failed.') return err.message;
  return 'Something went wrong. Please try again.';
}
