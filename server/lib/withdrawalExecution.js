// ---------------------------------------------------------------------------
// Admin treasury withdrawal execution: reserve, submit, record.
//
// Lifecycle stored in withdrawals.status (no CHECK constraint, so no migration):
//   pending  reserved before the provider is called. Blocks identical retries.
//   sent     the gateway accepted the transfer and returned a reference.
//            On-chain confirmation is NOT verified by this code.
//   failed   the gateway definitively REJECTED the transfer (HTTP 4xx). Nothing
//            was sent. The idempotency key is retired so a corrected retry can run.
//   unknown  the outcome is ambiguous (timeout, 5xx, no reference, or a record
//            that failed after a send). The transfer MAY have been broadcast.
//            It blocks retries until someone reconciles it on the gateway.
//
// Safety properties:
//   - The row is reserved BEFORE the provider call. A concurrent duplicate hits
//     the UNIQUE idempotency_key and never reaches the provider.
//   - An ambiguous result is never reported as "nothing was sent".
//   - Only a 4xx rejection can free the key for retry.
// ---------------------------------------------------------------------------
import { isUniqueViolation } from './pgDialect.js';

const DUPLICATE_MSG = 'This withdrawal is already being processed or was already booked — no duplicate was created.';

// `submit` is injected so tests can use a mock provider. It must reject with an
// error whose `kind` is 'rejected' only when the gateway definitively refused.
export async function executeWithdrawal({
  db,
  submit,
  redact = (s) => s,
  row,                 // { adminId, currency, currencyCode, address, mode, amountMinor, amountUsd, rate, fee, subtractFee }
  key,                 // idempotency key (unique column)
  now = Date.now(),
  windowMs = 120_000,  // identical successful sends are blocked for this long
  dayMs = 86_400_000,  // a sent key is blocked for this long
}) {
  const dup = () => ({ ok: false, http: 409, code: 'DUPLICATE', message: DUPLICATE_MSG });

  // Guard 1 — identical transfer already pending or unknown (any age, until
  // resolved), or sent within the recent window.
  const recent = db.prepare(
    `SELECT id FROM withdrawals
     WHERE (idempotency_key=? OR (mode=? AND currency=? AND address=? AND amount_minor=?))
       AND ( status IN ('pending','unknown') OR (status='sent' AND created_at > ?) )
     LIMIT 1`
  ).get(key, row.mode, row.currency, row.address, row.amountMinor, now - windowMs);
  if (recent) return dup();

  // Guard 2 — the same key was sent (or is unresolved) within the last day.
  const sent24h = db.prepare(
    `SELECT id FROM withdrawals WHERE idempotency_key=? AND status IN ('sent','unknown') AND created_at > ? LIMIT 1`
  ).get(key, now - dayMs);
  if (sent24h) return dup();

  // Reserve the row before any provider call. The UNIQUE key makes this the
  // single gate: a concurrent duplicate fails here and never submits.
  try {
    db.prepare(
      `INSERT INTO withdrawals (admin_id, currency, currency_code, address, mode,
        amount_minor, amount_usd, rate_inr, fee, subtract_fee, status, idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).run(
      row.adminId, row.currency, row.currencyCode, row.address, row.mode,
      row.amountMinor, row.amountUsd, row.rate, row.fee, row.subtractFee ? 1 : 0, key, now
    );
  } catch (e) {
    if (isUniqueViolation(e)) return dup();
    throw e;
  }

  let result;
  try {
    result = await submit();
  } catch (e) {
    const msg = String(redact(e?.message || 'error')).slice(0, 240);
    if (e && e.kind === 'rejected') {
      // Definitive refusal. Retire the key so a corrected retry is possible.
      db.prepare(`UPDATE withdrawals SET status='failed', error=?, idempotency_key=? WHERE idempotency_key=?`)
        .run(msg, `${key}#failed#${now}`, key);
      return { ok: false, http: 502, code: 'WITHDRAWAL_FAILED', message: 'The gateway rejected this withdrawal. Nothing was sent.' };
    }
    // Ambiguous: keep the key, so nothing can retry it until reconciled.
    db.prepare(`UPDATE withdrawals SET status='unknown', error=? WHERE idempotency_key=?`).run(msg, key);
    return {
      ok: false, http: 502, code: 'WITHDRAWAL_UNKNOWN',
      message: 'The result of this withdrawal is unknown. Do NOT retry. Check the gateway dashboard for this address and amount first.',
    };
  }

  try {
    db.prepare(
      `UPDATE withdrawals SET status='sent', transfer_ref=?, tx_hash=?, executed_at=? WHERE idempotency_key=?`
    ).run(result.ref, result.txHash, now, key);
  } catch (e) {
    // The gateway accepted the transfer but the record did not save. The row is
    // left pending/unknown, which blocks retries. Never report this as "not sent".
    db.prepare(`UPDATE withdrawals SET status='unknown', error=? WHERE idempotency_key=?`)
      .run('Accepted by the gateway but the local record could not be saved.', key);
    return {
      ok: false, http: 500, code: 'RECORD_FAILED',
      message: 'The gateway accepted this transfer, but it could not be recorded here. Do NOT retry. Reconcile it on the gateway dashboard.',
    };
  }
  return { ok: true, http: 201, result };
}
