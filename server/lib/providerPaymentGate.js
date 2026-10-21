// ---------------------------------------------------------------------------
// Provider-independent gate for INR deposit payment events.
//
// This module is PURE: no database, no config import, no network, no clock
// side effects beyond the explicit `now` argument. It decides what a
// normalised provider event means for an existing INR deposit. It never
// credits a wallet. Crediting stays with the existing, transactional
// `verifyInrDeposit` path, and automatic crediting is OFF by default.
//
// It does not know any provider's endpoints, field names or signing scheme.
// A provider adapter (written only after a provider is chosen and its
// documentation is read) must convert the provider's raw webhook into the
// normalised event shape documented below before calling these functions.
//
// Normalised event:
//   { eventId: string, orderId: string, status: 'SUCCESS'|'FAILED'|'EXPIRED'|'CANCELLED',
//     amountPaise: number (integer), currency: 'INR', paymentRef?: string }
//
// Deposit shape (fields of the inr_deposits row used here):
//   { order_id, total_paise, status: 'pending'|'awaiting_verification'|'verified'|'denied' }
// ---------------------------------------------------------------------------
import { createHmac, timingSafeEqual } from 'node:crypto';

export const EVENT_STATUSES = Object.freeze(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']);
// The only sources allowed to affect a deposit. Anything else is refused.
export const TRUSTED_SOURCES = Object.freeze(['provider_webhook', 'provider_status_api']);
export const MIN_SECRET_LENGTH = 32;
export const MAX_EVENT_ID_LENGTH = 200;
const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

// Verify an HMAC-SHA256 signature over the RAW request body.
// Fails closed: a missing or short secret, a malformed header, or any
// mismatch returns ok:false. Comparison is constant-time.
export function verifyWebhookSignature({ rawBody, signatureHeader, secret } = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: 'secret-missing-or-short' };
  }
  let body;
  if (typeof rawBody === 'string') body = Buffer.from(rawBody, 'utf8');
  else if (Buffer.isBuffer(rawBody)) body = rawBody;
  else return { ok: false, reason: 'raw-body-required' };
  if (typeof signatureHeader !== 'string' || !SIGNATURE_RE.test(signatureHeader)) {
    return { ok: false, reason: 'bad-signature-header' };
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature-mismatch' };
  }
  return { ok: true, reason: 'valid' };
}

// Decide what a normalised event means for one deposit.
// Returns a decision object. It performs no writes.
//   action: 'reject'        — do not touch the deposit (see reason)
//           'duplicate'     — deposit already terminal with the same outcome; no-op
//           'record'        — persist the event and move the deposit to the
//                             stated nextStatus; creditAllowed is false
//   creditAllowed: true ONLY when options.autoCreditEnabled === true and every
//                  check passed. Even then the caller must still use the
//                  transactional verify path and must not credit directly.
export function evaluateProviderEvent({ deposit, event, options = {} } = {}) {
  const reject = (reason) => ({ action: 'reject', reason, creditAllowed: false, nextStatus: null });

  if (!deposit || typeof deposit !== 'object') return reject('no-deposit');
  if (!event || typeof event !== 'object') return reject('no-event');

  // Source gate. Only a provider's signed webhook or a provider's own status
  // API may influence a deposit. A device notification, an SMS, a browser
  // redirect or a client-side claim is never proof of payment, however well
  // its amount and order id match.
  if (!TRUSTED_SOURCES.includes(event.source)) {
    return reject('untrusted-source');
  }

  // Idempotency key must be present and bounded.
  if (typeof event.eventId !== 'string' || event.eventId.length === 0
      || event.eventId.length > MAX_EVENT_ID_LENGTH) {
    return reject('event-id-missing-or-too-long');
  }
  // Exact order match. No trimming, no case folding, no prefix matching.
  if (typeof event.orderId !== 'string' || event.orderId !== deposit.order_id) {
    return reject('order-id-mismatch');
  }
  // Strict status enum. Anything else (including lowercase) is rejected.
  if (!EVENT_STATUSES.includes(event.status)) {
    return reject('invalid-status');
  }
  // Currency must be exactly INR.
  if (event.currency !== 'INR') {
    return reject('currency-mismatch');
  }
  // Amount: integer paise, exactly equal to the amount the customer was asked
  // to pay (total, including surcharge). No tolerance, no rounding.
  if (!Number.isSafeInteger(event.amountPaise)) {
    return reject('amount-not-integer-paise');
  }
  if (event.amountPaise !== Number(deposit.total_paise)) {
    return reject('amount-mismatch');
  }

  // Terminal deposits: the same outcome is a harmless duplicate; a different
  // outcome is rejected rather than overwriting a settled record.
  if (deposit.status === 'verified') {
    return event.status === 'SUCCESS'
      ? { action: 'duplicate', reason: 'already-verified', creditAllowed: false, nextStatus: 'verified' }
      : reject('conflicting-outcome-after-verified');
  }
  if (deposit.status === 'denied') {
    return event.status !== 'SUCCESS'
      ? { action: 'duplicate', reason: 'already-denied', creditAllowed: false, nextStatus: 'denied' }
      : reject('conflicting-outcome-after-denied');
  }
  if (deposit.status !== 'pending' && deposit.status !== 'awaiting_verification') {
    return reject('unknown-deposit-status');
  }

  // Map the provider outcome onto the existing deposit states.
  if (event.status === 'SUCCESS') {
    const autoCreditEnabled = options.autoCreditEnabled === true;
    return {
      action: 'record',
      reason: autoCreditEnabled ? 'auto-credit-eligible' : 'auto-credit-disabled',
      // Recorded as awaiting verification. Only the transactional verify path
      // may move it to 'verified' and credit the wallet.
      nextStatus: 'awaiting_verification',
      creditAllowed: autoCreditEnabled,
    };
  }
  // FAILED / EXPIRED / CANCELLED are terminal for this deposit.
  return { action: 'record', reason: `provider-${event.status.toLowerCase()}`, nextStatus: 'denied', creditAllowed: false };
}

// In-memory duplicate check for a single process. The database must enforce
// the same rule with a UNIQUE index on the stored event id; this helper is
// only for tests and for callers that batch events.
export function isDuplicateEvent(seenEventIds, eventId) {
  if (!(seenEventIds instanceof Set)) throw new TypeError('seenEventIds must be a Set');
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  return false;
}
