// ---------------------------------------------------------------------------
// Provider-independent INR deposit gate. No network, no database, no provider.
//   run: node scripts/test-provider-deposit-gate.mjs
//
//   S1  valid HMAC over the raw body is accepted
//   S2  wrong secret, tampered body, uppercase or truncated hex are rejected
//   S3  a short or missing secret fails closed
//   S4  a parsed object instead of the raw body is refused
//   X1  any source other than provider_webhook or provider_status_api is refused
//       (device notification, SMS, browser redirect, client claim, Gmail observer)
//   X2  provider_status_api is accepted
//   X3  an observer SUCCESS can never move a deposit to verified
//   E1  SUCCESS with exact total, INR, matching order → recorded, NOT credited
//   E2  amount off by one paise is refused (no tolerance)
//   E3  string or fractional amount is refused (integer paise only)
//   E4  currency other than INR is refused
//   E5  order id mismatch (including case or whitespace) is refused
//   E6  unknown or lowercase status is refused
//   E7  missing or oversized event id is refused
//   D1  duplicate SUCCESS after verified is a no-op, never a second credit
//   D2  conflicting outcome after verified or denied is refused
//   D3  FAILED / EXPIRED / CANCELLED move a pending deposit to denied
//   D4  in-memory duplicate detection flags a repeated event id
//   C1  auto-credit is off by default; creditAllowed stays false
//   C2  auto-credit flag on still returns only a decision, never a credit
//   C3  a deposit already in an unknown status is refused
// ---------------------------------------------------------------------------
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  evaluateProviderEvent,
  isDuplicateEvent,
  MIN_SECRET_LENGTH,
} from '../server/lib/providerPaymentGate.js';

let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

const SECRET = 'x'.repeat(MIN_SECRET_LENGTH); // test-only secret, never a real key
const BODY = '{"eventId":"evt-1","orderId":"INSTA-A1","status":"SUCCESS","amountPaise":11000,"currency":"INR"}';
const sign = (body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const DEPOSIT = { order_id: 'INSTA-A1', total_paise: 11000, status: 'pending' };
const EVENT = { eventId: 'evt-1', orderId: 'INSTA-A1', status: 'SUCCESS', amountPaise: 11000, currency: 'INR', source: 'provider_webhook' };
const ev = (over = {}) => ({ ...EVENT, ...over });
const dep = (over = {}) => ({ ...DEPOSIT, ...over });

console.log('provider deposit gate');

// --- S: signatures ---
const good = sign(BODY);
check('S1 valid signature over the raw body is accepted', verifyWebhookSignature({ rawBody: BODY, signatureHeader: good, secret: SECRET }).ok === true);
check('S1 Buffer body with the same bytes is accepted', verifyWebhookSignature({ rawBody: Buffer.from(BODY), signatureHeader: good, secret: SECRET }).ok === true);
check('S2 wrong secret is rejected', verifyWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY, 'y'.repeat(32)), secret: SECRET }).reason === 'signature-mismatch');
check('S2 tampered body is rejected', verifyWebhookSignature({ rawBody: BODY.replace('11000', '1100'), signatureHeader: good, secret: SECRET }).ok === false);
check('S2 uppercase hex is rejected', verifyWebhookSignature({ rawBody: BODY, signatureHeader: good.toUpperCase().replace('SHA256=', 'sha256='), secret: SECRET }).reason === 'bad-signature-header');
check('S2 truncated hex is rejected', verifyWebhookSignature({ rawBody: BODY, signatureHeader: good.slice(0, -2), secret: SECRET }).reason === 'bad-signature-header');
check('S2 missing prefix is rejected', verifyWebhookSignature({ rawBody: BODY, signatureHeader: good.slice(7), secret: SECRET }).reason === 'bad-signature-header');
check('S3 short secret fails closed', verifyWebhookSignature({ rawBody: BODY, signatureHeader: sign(BODY, 'short'), secret: 'short' }).reason === 'secret-missing-or-short');
check('S3 missing secret fails closed', verifyWebhookSignature({ rawBody: BODY, signatureHeader: good, secret: undefined }).ok === false);
check('S4 parsed object instead of raw body is refused', verifyWebhookSignature({ rawBody: { eventId: 'evt-1' }, signatureHeader: good, secret: SECRET }).reason === 'raw-body-required');

// --- E: exact event checks ---
check('E1 SUCCESS with exact total, INR, matching order is recorded only',
  (() => { const d = evaluateProviderEvent({ deposit: dep(), event: ev() }); return d.action === 'record' && d.nextStatus === 'awaiting_verification' && d.creditAllowed === false; })());
check('E2 amount one paise high is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ amountPaise: 11001 }) }).reason === 'amount-mismatch');
check('E2 amount one paise low is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ amountPaise: 10999 }) }).reason === 'amount-mismatch');
check('E2 credit amount (without surcharge) is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ amountPaise: 10000 }) }).reason === 'amount-mismatch');
check('E3 string amount is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ amountPaise: '11000' }) }).reason === 'amount-not-integer-paise');
check('E3 fractional amount is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ amountPaise: 11000.5 }) }).reason === 'amount-not-integer-paise');
check('E4 USD currency is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ currency: 'USD' }) }).reason === 'currency-mismatch');
check('E4 lowercase inr is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ currency: 'inr' }) }).reason === 'currency-mismatch');
check('E5 different order id is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ orderId: 'INSTA-B2' }) }).reason === 'order-id-mismatch');
check('E5 case-changed order id is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ orderId: 'insta-a1' }) }).reason === 'order-id-mismatch');
check('E5 whitespace-padded order id is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ orderId: ' INSTA-A1' }) }).reason === 'order-id-mismatch');
check('E6 unknown status is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ status: 'PAID' }) }).reason === 'invalid-status');
check('E6 lowercase success is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ status: 'success' }) }).reason === 'invalid-status');
check('E7 missing event id is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ eventId: '' }) }).reason === 'event-id-missing-or-too-long');
check('E7 oversized event id is refused', evaluateProviderEvent({ deposit: dep(), event: ev({ eventId: 'e'.repeat(201) }) }).reason === 'event-id-missing-or-too-long');
check('E0 no deposit is refused', evaluateProviderEvent({ deposit: null, event: ev() }).reason === 'no-deposit');

// --- X: source gate. A device or client signal is never proof of payment. ---
for (const src of ['device_notification', 'sms', 'browser_redirect', 'client_claim', 'gmail_observer', '', undefined]) {
  const d = evaluateProviderEvent({ deposit: dep(), event: ev({ source: src }) });
  check(`X1 source ${JSON.stringify(src)} is refused even with exact amount, order and INR`, d.reason === 'untrusted-source' && d.creditAllowed === false);
}
check('X2 provider_status_api is an accepted source', evaluateProviderEvent({ deposit: dep(), event: ev({ source: 'provider_status_api' }) }).action === 'record');
check('X3 observer source cannot mark a deposit verified even with SUCCESS', evaluateProviderEvent({ deposit: dep(), event: ev({ source: 'device_notification' }) }).nextStatus !== 'verified');

// --- D: duplicates, conflicts, terminal outcomes ---
const verified = dep({ status: 'verified' });
check('D1 duplicate SUCCESS after verified is a no-op', (() => { const d = evaluateProviderEvent({ deposit: verified, event: ev() }); return d.action === 'duplicate' && d.creditAllowed === false; })());
check('D2 FAILED after verified is refused', evaluateProviderEvent({ deposit: verified, event: ev({ status: 'FAILED' }) }).reason === 'conflicting-outcome-after-verified');
const denied = dep({ status: 'denied' });
check('D2 SUCCESS after denied is refused', evaluateProviderEvent({ deposit: denied, event: ev() }).reason === 'conflicting-outcome-after-denied');
check('D1 repeated FAILED after denied is a no-op', evaluateProviderEvent({ deposit: denied, event: ev({ status: 'EXPIRED' }) }).action === 'duplicate');
for (const s of ['FAILED', 'EXPIRED', 'CANCELLED']) {
  const d = evaluateProviderEvent({ deposit: dep(), event: ev({ status: s }) });
  check(`D3 ${s} moves a pending deposit to denied without credit`, d.action === 'record' && d.nextStatus === 'denied' && d.creditAllowed === false);
}
const seen = new Set();
check('D4 first delivery of an event id is not a duplicate', isDuplicateEvent(seen, 'evt-9') === false);
check('D4 repeated event id is flagged as duplicate', isDuplicateEvent(seen, 'evt-9') === true);
check('D4 non-Set argument throws', (() => { try { isDuplicateEvent([], 'x'); return false; } catch { return true; } })());

// --- C: crediting stays off ---
check('C1 auto-credit off by default: SUCCESS has creditAllowed false', evaluateProviderEvent({ deposit: dep(), event: ev() }).reason === 'auto-credit-disabled');
check('C2 auto-credit flag on still yields a decision, not a credit write',
  (() => { const d = evaluateProviderEvent({ deposit: dep(), event: ev(), options: { autoCreditEnabled: true } }); return d.reason === 'auto-credit-eligible' && d.nextStatus === 'awaiting_verification' && d.creditAllowed === true; })());
check('C2 truthy but non-true flag does not enable crediting', evaluateProviderEvent({ deposit: dep(), event: ev(), options: { autoCreditEnabled: 'yes' } }).creditAllowed === false);
check('C3 unknown deposit status is refused', evaluateProviderEvent({ deposit: dep({ status: 'weird' }), event: ev() }).reason === 'unknown-deposit-status');

console.log(`\nprovider deposit gate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
