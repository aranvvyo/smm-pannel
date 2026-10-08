import { getDb } from '../db.js';
import { notify } from './notifier.js';
import { fmtInr } from './money.js';
// Single source of truth for the INR money math (shared with the client).
import { inrCreditPaise, inrSurchargePaise, inrTotalPaise } from '../../client/src/lib/inrPayments.js';

// ---------------------------------------------------------------------------
// INR (VCGetaway) deposit workflow — MANUAL VERIFICATION ONLY.
//
// VCGetaway publishes no merchant API documentation (verified
// 2026-10-04): the only evidence is hosted invoice pages with an
// "I Have Paid" claim flow and verification states. There is no
// documented invoice-creation endpoint, authentication scheme,
// signature algorithm, status lookup or webhook contract — so this
// module NEVER:
//   • fabricates an invoice, UPI QR code, UPI ID or reference,
//   • treats a customer claim ("I have paid") as proof of payment,
//   • credits a wallet from any client-side flag or automated signal.
//
// The workflow:
//   1. Client requests a deposit  → PENDING record (credit / 10%
//      customer surcharge / total). Nothing is credited.
//   2. Customer pays the operator-issued UPI invoice (out of band —
//      the invoice itself is created in the operator's VCGetaway
//      dashboard until an API is documented).
//   3. Customer claims payment    → AWAITING_VERIFICATION. A claim is
//      a recorded statement, never verification.
//   4. Admin verifies the ACTUAL payment (against the gateway
//      dashboard / UPI confirmation) → wallet credited the CREDIT
//      amount — never the surcharge-inclusive total — exactly once,
//      atomically with the ledger entry, with the reason recorded.
//   5. Admin denies               → DENIED, no credit.
// ---------------------------------------------------------------------------

export function toClientView(d) {
  return {
    id: Number(d.id),
    credit_paise: Number(d.credit_paise),
    surcharge_paise: Number(d.surcharge_paise),
    total_paise: Number(d.total_paise),
    status: d.status,
    invoice_ref: d.invoice_ref || null,
    payment_ref: d.payment_ref || null,
    created_at: d.created_at,
    verified_at: d.verified_at || null,
  };
}

// Step 1 — request. Pending record only: no invoice/QR/UPI data is
// ever fabricated and nothing is credited.
export function createInrDeposit({ userId, rupees, invoiceRef } = {}) {
  const credit = inrCreditPaise(rupees);
  if (credit === null) return { ok: false, reason: 'invalid-amount' };
  const surcharge = inrSurchargePaise(credit);
  const total = inrTotalPaise(credit);
  const db = getDb();
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, invoice_ref, created_at)
     VALUES (?,?,?,?,'pending',?,?)`
  ).run(userId, credit, surcharge, total, invoiceRef ? String(invoiceRef).trim().slice(0, 200) : null, now);
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

// Step 4 — admin verification of the ACTUAL payment. Credits the
// wallet the CREDIT amount (never the total), exactly once, inside one
// transaction together with the ledger entry.
export function verifyInrDeposit({ adminId, depositId, paymentRef, invoiceRef, note } = {}) {
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(depositId);
  if (!deposit) return { ok: false, reason: 'not-found' };
  if (deposit.status === 'verified') return { ok: false, reason: 'already-verified' };
  if (deposit.status === 'denied') return { ok: false, reason: 'already-denied' };

  const now = Date.now();
  const credit = Number(deposit.credit_paise); // the CREDIT — never the total
  db.exec('BEGIN');
  try {
    // Conditional transition: the row flips exactly once, so the credit
    // below can never run twice (idempotent verification).
    const res = db.prepare(
      `UPDATE inr_deposits SET status='verified', payment_ref=?, invoice_ref=?,
         verified_by=?, verify_note=?, verified_at=?
       WHERE id=? AND status IN ('pending','awaiting_verification')`
    ).run(paymentRef, invoiceRef, adminId, note, now, deposit.id);
    if (res.changes === 0) { db.exec('ROLLBACK'); return { ok: false, reason: 'already-terminal' }; }

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(deposit.user_id);
    const newBalance = Number(user.wallet_balance) + credit;
    db.prepare('UPDATE users SET wallet_balance=? WHERE id=?').run(newBalance, user.id);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'deposit', ?, ?, ?, ?, ?)`
    ).run(user.id, credit, newBalance, deposit.id,
      JSON.stringify({
        method: 'inr_manual',
        invoice_ref: invoiceRef || undefined,
        payment_ref: paymentRef || undefined,
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
