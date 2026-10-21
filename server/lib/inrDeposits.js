import { getDb } from '../db.js';
import { notify } from './notifier.js';
import { fmtInr } from './money.js';
import { config } from '../config.js';
import { generateOrderId, buildUpiUri, GATEWAY_NAME } from './inrOrder.js';
import { isUniqueViolation } from './pgDialect.js';
// Single source of truth for the INR money math (shared with the client).
import { inrCreditPaise, inrSurchargePaise, inrTotalPaise, INR_MIN_CREDIT_PAISE } from '../../client/src/lib/inrPayments.js';

// ---------------------------------------------------------------------------
// INSTA SMM GATEWAY — INR deposit workflow.
//
// Documented VC Gateway flow:
//   generate unique Order ID → generate UPI QR → customer pays → verify.
//
// What this module does:
//   • creates a server-generated order id and a PENDING record,
//   • builds the documented UPI payment URI (amount = TOTAL payable),
//   • records a customer "I have paid" claim (never proof),
//   • credits a wallet ONLY through admin verification of the real payment.
//
// What it NEVER does:
//   • credit a wallet because an order or QR exists,
//   • trust a client-supplied status, amount, or transaction id,
//   • call a provider verification endpoint — none is documented yet.
//     Automatic crediting stays DISABLED until the provider's
//     verification contract is confirmed (see the TODO below).
//
// Workflow:
//   1. Client requests a deposit  → PENDING order + UPI URI. Nothing credited.
//   2. Customer pays the UPI URI  → out of band.
//   3. Customer claims payment    → AWAITING_VERIFICATION (recorded only).
//   4. Admin verifies the actual payment → wallet credited the CREDIT amount
//      (never the total), exactly once, atomically with the ledger entry.
//   5. Admin denies               → DENIED, no credit.
//
// TODO(verification): automatic verification is blocked on the provider
//   contract. Once VC Gateway documents the verification request, response
//   fields (PAID/PENDING/FAILED/...) and whether it is the same
//   payment_api.php endpoint, add a server-side check here that credits
//   ONLY on a verified SUCCESS with matching order_id, exact total amount,
//   INR currency, and no prior credit for that order_id.
// ---------------------------------------------------------------------------

export function toClientView(d) {
  const orderId = d.order_id || null;
  return {
    id: Number(d.id),
    gateway: GATEWAY_NAME,
    order_id: orderId,
    credit_paise: Number(d.credit_paise),
    surcharge_paise: Number(d.surcharge_paise),
    total_paise: Number(d.total_paise),
    status: d.status,
    // Documented UPI URI for the QR. Only for orders that carry an order id.
    // A misconfigured UPI id must never break listing pages: fail to null.
    upi_uri: (() => {
      if (!orderId) return null;
      try {
        return buildUpiUri({ upiId: config.vcGetaway.upiId, orderId, totalPaise: Number(d.total_paise) });
      } catch { return null; }
    })(),
    invoice_ref: d.invoice_ref || null,
    payment_ref: d.payment_ref || null,
    created_at: d.created_at,
    verified_at: d.verified_at || null,
  };
}

// Step 1 — request. Pending record only: nothing is credited.
export function createInrDeposit({ userId, rupees, invoiceRef } = {}) {
  const credit = inrCreditPaise(rupees);
  if (credit === null) return { ok: false, reason: 'invalid-amount' };
  // Documented minimum (₹1.00 wallet credit). Enforced here, before any row
  // is written, so no below-minimum deposit can exist.
  if (credit < INR_MIN_CREDIT_PAISE) return { ok: false, reason: 'below-minimum' };
  const surcharge = inrSurchargePaise(credit);
  const total = inrTotalPaise(credit);
  const db = getDb();
  const now = Date.now();
  // The order id is generated HERE, never taken from the client. The unique
  // index on order_id makes a collision fail loudly; we retry a few times.
  let info = null;
  for (let attempt = 0; attempt < 5 && !info; attempt++) {
    const orderId = generateOrderId(new Date(now));
    try {
      info = db.prepare(
        `INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, invoice_ref, created_at, order_id)
         VALUES (?,?,?,?,'pending',?,?,?)`
      ).run(userId, credit, surcharge, total, invoiceRef ? String(invoiceRef).trim().slice(0, 200) : null, now, orderId);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;   // retry only on an order-id collision
    }
  }
  if (!info) return { ok: false, reason: 'order-id-collision' };
  const row = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(Number(info.lastInsertRowid));
  try {
    notify(userId, 'deposit', 'INR Deposit Requested',
      `${fmtInr(total)} to pay (includes ${fmtInr(surcharge)} customer surcharge) — your wallet will be credited ${fmtInr(credit)} after the payment is verified.`);
  } catch { /* never block on a notification */ }
  return { ok: true, deposit: row };
}

// Step 3 — customer claim. RECORDS the "I have paid" statement and
// nothing else: a claim is never proof of payment and never credits.
export function claimInrDeposit({ userId, depositId } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inr_deposits WHERE id=? AND user_id=?').get(depositId, userId);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not-pending' };
  const res = db.prepare(
    "UPDATE inr_deposits SET status='awaiting_verification' WHERE id=? AND status='pending'"
  ).run(row.id);
  if (res.changes === 0) return { ok: false, reason: 'not-pending' };
  return { ok: true, deposit: db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(row.id) };
}

// The bank/UPI reference the admin verifies against: 6–35 letters, digits,
// '-', '_' or '/'. Anything else is refused, so a free-text note can never be
// stored as a "payment reference".
export const PAYMENT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/]{5,34}$/;
// Stored and compared in UPPER case: the same bank reference typed in a
// different case is the same payment.
export function normalizePaymentRef(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return PAYMENT_REF_RE.test(s) ? s : null;
}

// Step 4 — admin verification of the ACTUAL payment. Credits the
// wallet the CREDIT amount (never the total), exactly once, inside one
// transaction together with the ledger entry.
//
// Refused (no write, no credit):
//   • a missing or malformed payment reference,
//   • a reference already used by ANOTHER verified deposit (one bank payment
//     must never back two wallet credits),
//   • an admin verifying a deposit they own (separation of duties),
//   • a terminal deposit (already verified or denied).
export function verifyInrDeposit({ adminId, depositId, paymentRef, invoiceRef, note } = {}) {
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(depositId);
  if (!deposit) return { ok: false, reason: 'not-found' };
  if (deposit.status === 'verified') return { ok: false, reason: 'already-verified' };
  if (deposit.status === 'denied') return { ok: false, reason: 'already-denied' };
  if (Number(deposit.user_id) === Number(adminId)) return { ok: false, reason: 'self-verification-forbidden' };
  const ref = normalizePaymentRef(paymentRef);
  if (!ref) return { ok: false, reason: 'payment-ref-required-or-invalid' };

  const now = Date.now();
  const credit = Number(deposit.credit_paise); // the CREDIT — never the total
  db.exec('BEGIN');
  try {
    // Reuse check inside the transaction: one bank payment cannot verify two deposits.
    const reused = db.prepare(
      `SELECT id FROM inr_deposits WHERE UPPER(payment_ref)=? AND status='verified' AND id<>?`
    ).get(ref, deposit.id);
    if (reused) { db.exec('ROLLBACK'); return { ok: false, reason: 'payment-ref-already-used' }; }

    // Conditional transition: the row flips exactly once, so the credit
    // below can never run twice (idempotent verification).
    const res = db.prepare(
      `UPDATE inr_deposits SET status='verified', payment_ref=?, invoice_ref=?,
         verified_by=?, verify_note=?, verified_at=?
       WHERE id=? AND status IN ('pending','awaiting_verification')`
    ).run(ref, invoiceRef ?? null, adminId, note ?? null, now, deposit.id);
    if (res.changes === 0) { db.exec('ROLLBACK'); return { ok: false, reason: 'already-terminal' }; }

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(deposit.user_id);
    if (!user) { db.exec('ROLLBACK'); return { ok: false, reason: 'user-not-found' }; }
    // Atomic arithmetic on the live balance (no read-modify-write).
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?').run(credit, user.id);
    const newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'deposit', ?, ?, ?, ?, ?)`
    ).run(user.id, credit, newBalance, deposit.id,
      JSON.stringify({
        method: 'inr_manual',
        invoice_ref: invoiceRef || undefined,
        payment_ref: ref,
        surcharge_paise: Number(deposit.surcharge_paise),
        total_paise: Number(deposit.total_paise),
      }), now);
    try {
      notify(user.id, 'deposit', 'Deposit Confirmed',
        `INR deposit verified — ${fmtInr(credit)} credited to your wallet (you paid ${fmtInr(Number(deposit.total_paise))} including the customer surcharge).`);
    } catch { /* never block on a notification */ }
    db.exec('COMMIT');
    return { ok: true, inr: credit };
  } catch (e) {
    db.exec('ROLLBACK');
    // A racing verification of another deposit with the same reference can be
    // stopped by a unique index on payment_ref, if the opt-in migration has been
    // applied (docs/migrations/MIGRATION_inr_payment_ref_unique.sql). Without that
    // index, the in-transaction check above is the only guard. That is a refusal, not a crash.
    if (isUniqueViolation(e)) return { ok: false, reason: 'payment-ref-already-used' };
    throw e;
  }
}

// Step 5 — admin denial. Terminal, no credit, user notified.
export function denyInrDeposit({ adminId, depositId, reason } = {}) {
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(depositId);
  if (!deposit) return { ok: false, reason: 'not-found' };
  if (deposit.status === 'verified') return { ok: false, reason: 'already-verified' };
  if (deposit.status === 'denied') return { ok: false, reason: 'already-denied' };
  const res = db.prepare(
    `UPDATE inr_deposits SET status='denied', verify_note=?, verified_by=?, verified_at=?
     WHERE id=? AND status IN ('pending','awaiting_verification')`
  ).run(reason, adminId, Date.now(), deposit.id);
  if (res.changes === 0) return { ok: false, reason: 'already-terminal' };
  try {
    notify(deposit.user_id, 'deposit', 'Deposit Not Verified',
      `Your INR deposit of ${fmtInr(Number(deposit.total_paise))} could not be verified — no amount was credited. Contact support if you believe this is an error.`);
  } catch { /* never block on a notification */ }
  return { ok: true };
}
