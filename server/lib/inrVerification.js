// ---------------------------------------------------------------------------
// Automatic INR verification (VC Gateway). Wallet crediting lives here.
//
// Credit happens ONLY when ALL of these hold:
//   1. The adapter reports a parsed response (not unavailable, not malformed).
//   2. The response's order id equals the deposit's stored order id.
//   3. The response status is SUCCESS, and its amount equals the deposit's
//      TOTAL payable (credit + 10% fee). The customer pays the total; the
//      wallet receives the CREDIT amount.
//   4. config.vcGetaway.autoCreditEnabled is true AND the adapter's contract is
//      confirmed. Today the contract is not confirmed, so no automatic credit
//      can happen.
//
// Exactly-once: the status flip is a conditional UPDATE inside the same
// transaction as the wallet update and the ledger row. A second attempt finds
// the row terminal and changes nothing. The ledger has no unique reference
// constraint yet; see the report for why it was not added.
//
// Never credited: a button click, a QR being generated, a client-supplied
// status or amount, PENDING, FAILED, INVALID, NOT_FOUND, unknown statuses,
// malformed or unavailable responses, or a mismatched order or amount.
// ---------------------------------------------------------------------------
import { getDb } from '../db.js';
import { config } from '../config.js';
import { notify } from './notifier.js';
import { fmtInr } from './money.js';
import { productionAdapter, isTrustedVerifier, isAdapterIssuedReply, redactSecrets } from './vcGatewayAdapter.js';

// Pure classification of a parsed provider reply against the local deposit.
export function classifyGatewayResult(raw, expected) {
  if (!raw || typeof raw !== 'object') return { state: 'unverified', reason: 'malformed' };
  if (typeof raw.orderId !== 'string' || raw.orderId !== expected.orderId) {
    return { state: 'unverified', reason: 'order-mismatch' };
  }
  switch (raw.status) {
    case 'SUCCESS':
      if (!Number.isSafeInteger(raw.amountPaise) || raw.amountPaise !== expected.totalPaise) {
        return { state: 'unverified', reason: 'amount-mismatch' };
      }
      return { state: 'verified' };
    case 'PENDING':   return { state: 'pending' };
    case 'FAILED':    return { state: 'failed' };
    case 'INVALID':   return { state: 'invalid' };
    case 'NOT_FOUND': return { state: 'not_found' };
    default:          return { state: 'unverified', reason: 'unknown-status' };
  }
}

// Automatic crediting requires the config switch AND a confirmed contract.
// The switch alone is never enough: a contract that has not been reviewed
// cannot be enabled by configuration.
export function automaticCreditingAllowed(adapter = productionAdapter) {
  return config.vcGetaway.autoCreditEnabled === true && adapter.isContractConfirmed === true;
}

// Verification tokens. The ONLY way to obtain one is issueVerification(), which
// runs the classification and requires a confirmed contract. The credit
// function accepts only a token it issued (WeakSet membership), so no caller
// can credit by passing order data or a status of its own.
const issuedTokens = new WeakSet();
export function issueVerification({ adapter, expected, raw }) {
  // Only a verifier from the trusted set can mint a token. A plain object that
  // claims isContractConfirmed is refused here, whatever its checkOrder returns.
  if (!isTrustedVerifier(adapter)) return { ok: false, reason: 'untrusted-verifier' };
  if (adapter.isContractConfirmed !== true) return { ok: false, reason: 'contract-unconfirmed' };
  // The reply must be one this trusted adapter parsed itself (see checkOrder).
  if (!isAdapterIssuedReply(raw)) return { ok: false, reason: 'untrusted-reply' };
  const c = classifyGatewayResult(raw, expected);
  if (c.state !== 'verified') return { ok: false, reason: c.reason || c.state };
  const token = Object.freeze({ orderId: expected.orderId, totalPaise: expected.totalPaise });
  issuedTokens.add(token);
  return { ok: true, token };
}

// Atomic credit of the CREDIT amount, with the deposit status flip and the
// ledger row in one transaction. Rolls back completely on any failure.
// Requires an issued token AND the automatic-credit switch, checked again
// here so no path can bypass either one.
export function creditVerifiedInrDeposit({ depositId, verification }) {
  if (!issuedTokens.has(verification)) return { ok: false, reason: 'no-verification' };
  if (config.vcGetaway.autoCreditEnabled !== true) return { ok: false, reason: 'auto-credit-disabled' };
  const orderId = verification.orderId;
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(depositId);
  if (!deposit) return { ok: false, reason: 'not-found' };
  if (deposit.order_id !== orderId) return { ok: false, reason: 'order-mismatch' };
  if (Number(deposit.total_paise) !== verification.totalPaise) return { ok: false, reason: 'amount-mismatch' };
  if (!['pending', 'awaiting_verification'].includes(deposit.status)) {
    return { ok: false, reason: 'already-' + deposit.status };
  }
  const credit = Number(deposit.credit_paise); // the CREDIT, never the total
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const res = db.prepare(
      `UPDATE inr_deposits SET status='verified', verify_note=?, verified_at=?
       WHERE id=? AND order_id=? AND status IN ('pending','awaiting_verification')`
    ).run('verified by gateway', now, deposit.id, orderId);
    if (res.changes !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'already-terminal' };
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(deposit.user_id);
    // Atomic arithmetic on the live balance (no read-modify-write).
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?').run(credit, user.id);
    const newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'deposit', ?, ?, ?, ?, ?)`
    ).run(user.id, credit, newBalance, deposit.id,
      JSON.stringify({
        method: 'inr_gateway',
        order_id: orderId,
        surcharge_paise: Number(deposit.surcharge_paise),
        total_paise: Number(deposit.total_paise),
      }), now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  try {
    notify(deposit.user_id, 'deposit', 'Deposit Confirmed',
      `INR deposit verified — ${fmtInr(credit)} credited to your wallet (you paid ${fmtInr(Number(deposit.total_paise))} including the customer surcharge).`);
  } catch { /* never block on a notification */ }
  return { ok: true, inr: credit };
}

// Checks one deposit with the provider and credits it only if verified.
// Terminal deposits are never sent to the provider. Non-verified outcomes
// leave the row unchanged.
export async function verifyDepositOnce({ depositId, adapter = productionAdapter } = {}) {
  const db = getDb();
  const d = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(depositId);
  if (!d) return { state: 'not_found', credited: false };
  if (['verified', 'denied'].includes(d.status)) return { state: 'terminal', status: d.status, credited: false };
  if (!d.order_id) return { state: 'unverified', reason: 'legacy-deposit-without-order', credited: false };
  // Refuse untrusted verifiers BEFORE any provider call, so an arbitrary
  // adapter's checkOrder never runs in the verification path.
  if (!isTrustedVerifier(adapter)) return { state: 'unverified', reason: 'untrusted-verifier', credited: false };

  const expected = { orderId: d.order_id, totalPaise: Number(d.total_paise) };
  const check = await adapter.checkOrder({ orderId: expected.orderId, totalPaise: expected.totalPaise });
  if (check.state === 'unavailable') return { state: 'unavailable', reason: check.reason, credited: false };
  if (check.state !== 'response') return { state: 'unverified', reason: check.reason, credited: false };

  // Non-SUCCESS outcomes are reported as their own state and never credit.
  const c = classifyGatewayResult(check.raw, expected);
  if (c.state !== 'verified') return { state: c.state, reason: c.reason, credited: false };

  // Only a token issued by issueVerification() can reach the credit function.
  const iv = issueVerification({ adapter, expected, raw: check.raw });
  if (!iv.ok) {
    return { state: iv.reason === 'contract-unconfirmed' ? 'unavailable' : 'unverified', reason: iv.reason, credited: false };
  }
  if (!automaticCreditingAllowed(adapter)) {
    // Verified by the provider, but automatic crediting is switched off.
    // Nothing is credited and nothing is marked verified.
    return { state: 'verified-credit-disabled', credited: false };
  }
  const out = creditVerifiedInrDeposit({ depositId: d.id, verification: iv.token });
  return { state: 'verified', credited: out.ok, reason: out.ok ? undefined : out.reason };
}

// Bounded batch for the background poller: only live, recent, non-terminal
// deposits that have an order id.
export async function verifyPendingBatch({ adapter = productionAdapter, batch = 20, maxAgeMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const rows = getDb().prepare(
    `SELECT id FROM inr_deposits
     WHERE status IN ('pending','awaiting_verification') AND order_id IS NOT NULL AND created_at > ?
     ORDER BY created_at LIMIT ?`
  ).all(now - maxAgeMs, batch);
  const results = [];
  for (const r of rows) {
    try {
      results.push(await verifyDepositOnce({ depositId: r.id, adapter }));
    } catch (e) {
      // Never log secrets. The deposit stays pending and is retried next tick.
      console.error('[instasmm] INR verification error:', redactSecrets(e?.message));
      results.push({ state: 'error', credited: false });
    }
  }
  return results;
}

// One poll pass. Never rejects: a failure (for example a database error) is
// logged with a redacted message and reported as { error }. The overlap flag is
// cleared in finally, so one failed pass never blocks the next one.
let polling = false;
export async function runInrPollOnce({ adapter = productionAdapter } = {}) {
  if (polling) return { skipped: 'overlap' };   // never overlap poll jobs in this process
  polling = true;
  try {
    return { results: await verifyPendingBatch({ adapter }) };
  } catch (e) {
    console.error('[instasmm] INR verification poll failed; retrying next tick:', redactSecrets(e?.message));
    return { error: 'poll-failed' };
  } finally {
    polling = false;
  }
}

// Background poller. Starts ONLY when automatic crediting is allowed. Today it
// is never started, because the contract is unconfirmed and the switch is off.
export function startInrVerificationPoller({ adapter = productionAdapter, intervalMs = 60_000 } = {}) {
  if (!automaticCreditingAllowed(adapter)) {
    console.log('[instasmm] INR automatic verification is OFF (contract not confirmed or autoCreditEnabled=false).');
    return null;
  }
  console.log('[instasmm] INR automatic verification poller started.');
  // The tick is a non-rejecting promise, so no unhandled rejection is possible.
  return setInterval(() => { void runInrPollOnce({ adapter }); }, intervalMs);
}
