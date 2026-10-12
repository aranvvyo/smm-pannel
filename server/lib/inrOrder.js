// ---------------------------------------------------------------------------
// INSTA SMM GATEWAY — pure order helpers (no I/O, no network, no secrets).
//
// Everything here follows the DOCUMENTED VC Gateway flow only:
//   Generate unique Order ID → generate UPI QR → customer pays → verify.
//
// Nothing in this module calls the provider and nothing in it decides that
// a payment succeeded. Crediting a wallet is never done from these helpers.
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';

// Customer-facing gateway name. "VC Gateway" must not be shown to customers.
export const GATEWAY_NAME = 'INSTA SMM GATEWAY';

// Order ID format matches the provider's documented example (ORD261008LSWA4K):
// "ORD" + YYMMDD (UTC date) + 6 random uppercase alphanumerics.
const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
export function generateOrderId(now = new Date(), randomFn = randomBytes) {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const bytes = randomFn(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ORDER_ALPHABET[bytes[i] % ORDER_ALPHABET.length];
  return `ORD${yy}${mm}${dd}${suffix}`;
}

// Order IDs we generate. Anything else is rejected before a DB lookup.
export function isValidOrderId(id) {
  return typeof id === 'string' && /^ORD\d{6}[A-Z2-9]{6}$/.test(id);
}

// UPI VPA: "name@handle". Rejects anything that could break the URI.
const UPI_VPA_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
export function isValidUpiId(vpa) {
  return typeof vpa === 'string' && UPI_VPA_RE.test(vpa);
}

// Integer paise → "110.00" using integer arithmetic only (no float drift).
export function paiseToRupeeString(paise) {
  const p = Number(paise);
  if (!Number.isSafeInteger(p) || p < 0) throw new Error('paise must be a non-negative safe integer');
  return `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
}

// Payee name shown in the customer's UPI app.
export const UPI_PAYEE_NAME = 'InstaSMM';

// The documented UPI payment URI:
//   upi://pay?pa=<UPI ID>&pn=<Payee>&am=<amount>&cu=INR&tn=<ORDER_ID>
// The amount is the customer's TOTAL payable (credit + 10% fee), never the
// wallet credit. The order ID in `tn` lets the provider match the payment.
export function buildUpiUri({ upiId, orderId, totalPaise, payeeName = UPI_PAYEE_NAME }) {
  if (!isValidUpiId(upiId)) throw new Error('invalid UPI id');
  if (!isValidOrderId(orderId)) throw new Error('invalid order id');
  if (typeof payeeName !== 'string' || !/^[A-Za-z0-9 ._-]{1,50}$/.test(payeeName)) {
    throw new Error('invalid payee name');
  }
  const am = paiseToRupeeString(totalPaise);
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${am}&cu=INR&tn=${orderId}`;
}
