// ---------------------------------------------------------------------------
// Customer order lifecycle: reserve → submit → settle. Every money movement is
// one transaction guarded by a conditional status change, so it happens at most
// once even under concurrent or repeated calls.
//
// Order statuses added by this module (orders.status has no CHECK constraint):
//   SUBMITTING  balance reserved, supplier call in flight (or its outcome not yet
//               recorded). Blocks identical orders. Never auto-refunded.
//   AMBIGUOUS   the supplier may have accepted the order (timeout, 5xx, malformed
//               or missing reply, or a record that failed to save). The balance
//               stays reserved. Only an admin reconciliation can resolve it. The
//               sync ticker does not touch it.
//   REJECTED    the supplier DEFINITELY refused. The reservation was refunded
//               exactly once and the coupon use was released.
//   PENDING / IN_PROGRESS / COMPLETED ... set only after supplier acceptance.
//
// Money rules:
//   - Reserve: one transaction, conditional debit + order row + ledger + coupon.
//   - Reject or reconcile-reject: one transaction, claim AMBIGUOUS/SUBMITTING →
//     REJECTED, then refund the EXACT ledger debit and release the coupon.
//   - Accept: no money movement. The reservation becomes the charge.
//   - Ambiguous: no money movement. Held until reconciled. Never retried.
// ---------------------------------------------------------------------------
import { config } from '../config.js';
import { newId } from '../db.js';
import { isUniqueViolation } from './pgDialect.js';
import { logSecurity } from '../middleware/auth.js';

export const STATUS_SUBMITTING = 'SUBMITTING';
export const STATUS_AMBIGUOUS = 'AMBIGUOUS';
export const STATUS_REJECTED = 'REJECTED';

export const STALE_SUBMITTING_MS = 5 * 60_000;

export class InsufficientBalanceError extends Error {
  constructor(message = 'Insufficient balance') { super(message); this.code = 'INSUFFICIENT_BALANCE'; }
}
// Customer-facing when the supplier definitively refused. Its message never
// contains supplier text.
export class ProviderError extends Error {
  constructor(message = 'The supplier did not accept this order, so your balance was not charged.') {
    super(message); this.code = 'PROVIDER_ERROR';
  }
}
export class DuplicateOrderError extends Error {
  constructor(message = 'An identical order is already being verified. It will not be charged twice.') {
    super(message); this.code = 'DUPLICATE_ORDER';
  }
}
// The supplier outcome is unknown. The order is held, not refunded, and must not
// be placed again by the customer.
export class OrderVerifyingError extends Error {
  constructor(orderRef, message = 'Your order is being verified with the supplier. Your balance stays reserved until we confirm it. Please do not place this order again.') {
    super(message); this.code = 'VERIFYING'; this.orderRef = orderRef;
  }
}
export class LifecycleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Classification drives money decisions ONLY through `kind`:
//   'rejected' — the supplier answered with a definitive refusal (nothing accepted).
//   'unknown'  — anything else. The supplier may have accepted the order.
// `category` is a fixed, non-sensitive label for admin alerts. Free-text supplier
// messages never leave this module.
const CATEGORIES = new Set([
  'provider_rejected', 'insufficient_supplier_funds', 'timeout', 'network', 'http_5xx',
  'non_json', 'no_reference', 'ambiguous', 'record_failed', 'duplicate_supplier_order_id',
  'not_submitting', 'factory_error',
]);
function safeCategory(c, fallback) { return CATEGORIES.has(c) ? c : fallback; }

export function classifyProviderFailure(err) {
  if (err && err.kind === 'rejected') {
    return { kind: 'rejected', category: safeCategory(err.category, 'provider_rejected') };
  }
  const fallback = err && err.name === 'TimeoutError' ? 'timeout' : 'ambiguous';
  return { kind: 'unknown', category: safeCategory(err && err.category, fallback) };
}

// Admin-only gate, mirroring requireAdmin in middleware/auth.js.
export function assertAdmin(user) {
  if (!user || user.role !== 'admin' || !(user.email in config.admins)) {
    throw new LifecycleError('FORBIDDEN', 'Admin access required.');
  }
}

// ---- Admin alerts ----------------------------------------------------------
// Private, admin-only, deduplicated: the same kind + provider + category is
// recorded at most once per 10 minutes, so a provider that keeps refusing cannot
// flood the log.
const lastAlert = new Map();
const ALERT_DEDUPE_MS = 10 * 60_000;
export function alertAdmin(kind, { providerId, providerName, orderRef, category }, now = Date.now()) {
  const key = `${kind}|${providerId}|${category}`;
  const last = lastAlert.get(key);
  if (last !== undefined && now - last < ALERT_DEDUPE_MS) return false;
  lastAlert.set(key, now);
  // Detail contains only identifiers and a fixed category. Never a raw supplier
  // message, a URL, or a credential.
  logSecurity(null, 'system', kind, 'system', JSON.stringify({
    provider_id: providerId, provider: String(providerName || '').slice(0, 60),
    order_ref: orderRef, category, at: new Date(now).toISOString(),
  }));
  return true;
}

// ---- Reserve ---------------------------------------------------------------
// One transaction: conditional debit, order row (SUBMITTING), ledger row, and
// coupon consumption. Throws InsufficientBalanceError, DuplicateOrderError, or
// LifecycleError('BAD_COUPON'). Nothing is written on a throw.
export function reserveOrder({ db, user, service, provider, quantity, link, pricing, coupon, now = Date.now() }) {
  const final = pricing.final;
  // Identical order in flight or waiting for reconciliation: refuse.
  const pending = db.prepare(
    `SELECT id FROM orders
     WHERE user_id=? AND service_id=? AND link=? AND quantity=? AND status IN (?, ?)
     LIMIT 1`
  ).get(user.id, service.id, link, quantity, STATUS_SUBMITTING, STATUS_AMBIGUOUS);
  if (pending) throw new DuplicateOrderError();

  const orderRef = newId('ORD-');
  db.exec('BEGIN');
  try {
    // Conditional debit: checked against the live balance inside the write.
    const debit = db.prepare(
      `UPDATE users SET wallet_balance = wallet_balance - ?, total_spent_inr = total_spent_inr + ?
       WHERE id=? AND wallet_balance >= ?`
    ).run(final, final, user.id, final);
    if (debit.changes !== 1) throw new InsufficientBalanceError();
    const newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance);

    const res = db.prepare(
      `INSERT INTO orders
         (order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity,
          price_inr, base_cost_inr, coupon_id, discount_inr, status,
          start_count, remains, provider_charge, provider_currency, created_at, updated_at)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,0,?,NULL,?,?,?)`
    ).run(
      orderRef, user.id, service.id, provider.id, link, quantity,
      pricing.price, pricing.base, coupon?.id ?? null, pricing.discount,
      STATUS_SUBMITTING, quantity, provider.currency || null, now, now
    );
    const orderId = Number(res.lastInsertRowid);

    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'order', ?, ?, ?, ?, ?)`
    ).run(user.id, -final, newBalance, orderId, JSON.stringify({ service: service.name, order: orderRef }), now);

    if (coupon) {
      const consumed = db.prepare(
        `UPDATE coupons SET used_count = used_count + 1
         WHERE id = ? AND (usage_limit IS NULL OR used_count < usage_limit)`
      ).run(coupon.id);
      if (consumed.changes !== 1) throw new LifecycleError('BAD_COUPON', 'Coupon usage limit reached.');
      db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, order_id, discount_inr, created_at) VALUES (?,?,?,?,?)')
        .run(coupon.id, user.id, orderId, pricing.discount, now);
    }
    db.exec('COMMIT');
    return { orderId, orderRef, newBalance };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    throw e;
  }
}

// ---- Settle ----------------------------------------------------------------
// Supplier accepted. Record the supplier id and move to the supplier's status.
// The unique index on (provider_id, provider_order_id) refuses a supplier id that
// is already recorded. The caller then marks the order AMBIGUOUS (never refunds).
export function settleAccepted({ db, orderId, providerOrderId, initialStatus, charge, currency, now = Date.now() }) {
  try {
    const r = db.prepare(
      `UPDATE orders SET provider_order_id=?, status=?, provider_charge=?, provider_currency=?, updated_at=?
       WHERE id=? AND status=?`
    ).run(providerOrderId, initialStatus, Number.isFinite(charge) ? charge : null, currency || null, now, orderId, STATUS_SUBMITTING);
    if (r.changes !== 1) return { ok: false, category: 'not_submitting' };
    return { ok: true };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, category: 'duplicate_supplier_order_id' };
    throw e;
  }
}

// Marks SUBMITTING → AMBIGUOUS. Returns true only for the transition that happened.
export function markAmbiguous(db, orderId, now = Date.now()) {
  const r = db.prepare(`UPDATE orders SET status=?, updated_at=? WHERE id=? AND status=?`)
    .run(STATUS_AMBIGUOUS, now, orderId, STATUS_SUBMITTING);
  return r.changes === 1;
}

// Claims `fromStatus` → REJECTED and refunds the reservation exactly once, in one
// transaction. Returns { refunded, refund } and never refunds twice.
function rejectAndRefund({ db, orderId, fromStatus, reason, now }) {
  db.exec('BEGIN');
  try {
    const claim = db.prepare(`UPDATE orders SET status=?, updated_at=? WHERE id=? AND status=?`)
      .run(STATUS_REJECTED, now, orderId, fromStatus);
    if (claim.changes !== 1) {
      db.exec('ROLLBACK');
      return { refunded: false, refund: 0 };
    }
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    // Refund the EXACT amount debited when the order was reserved.
    const debit = db.prepare(
      `SELECT amount_inr FROM transactions WHERE type='order' AND ref_id=? AND user_id=? LIMIT 1`
    ).get(orderId, order.user_id);
    const refund = debit ? -Number(debit.amount_inr) : 0;
    if (!(refund > 0)) throw new LifecycleError('NO_DEBIT', 'No reservation found for this order.');

    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, total_spent_inr = total_spent_inr - ? WHERE id=?')
      .run(refund, refund, order.user_id);
    const newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(order.user_id).wallet_balance);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'refund', ?, ?, ?, ?, ?)`
    ).run(order.user_id, refund, newBalance, orderId, JSON.stringify({ order: order.order_ref, reason }), now);

    if (order.coupon_id) {
      // Release exactly what this order consumed.
      db.prepare('UPDATE coupons SET used_count = used_count - 1 WHERE id=? AND used_count > 0').run(order.coupon_id);
      db.prepare('DELETE FROM coupon_uses WHERE order_id=?').run(orderId);
    }
    db.exec('COMMIT');
    return { refunded: true, refund };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* none open */ }
    throw e;
  }
}

// The supplier DEFINITIVELY refused a SUBMITTING order.
export function settleRejected({ db, orderId, reason = 'supplier_rejected', now = Date.now() }) {
  return rejectAndRefund({ db, orderId, fromStatus: STATUS_SUBMITTING, reason, now });
}

// ---- Admin reconciliation --------------------------------------------------
// Resolves an AMBIGUOUS order. Only an admin may call it, and only with evidence:
//   accept  — the admin confirmed the supplier order at the supplier, and gives its id.
//   reject  — the admin confirmed the supplier did NOT accept it. Refunds once.
export function reconcileOrder({ db, admin, orderId, action, providerOrderId, now = Date.now() }) {
  assertAdmin(admin);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new LifecycleError('NOT_FOUND', 'Order not found.');
  if (order.status !== STATUS_AMBIGUOUS) {
    throw new LifecycleError('NOT_AMBIGUOUS', 'Only ambiguous orders can be reconciled.');
  }
  let outcome;
  if (action === 'accept') {
    const id = String(providerOrderId || '').trim();
    if (!id || id.length > 120 || /\s/.test(id)) throw new LifecycleError('BAD_PROVIDER_ID', 'Enter the supplier order ID exactly as shown at the supplier.');
    try {
      const r = db.prepare(`UPDATE orders SET provider_order_id=?, status='PENDING', updated_at=? WHERE id=? AND status=?`)
        .run(id, now, orderId, STATUS_AMBIGUOUS);
      if (r.changes !== 1) throw new LifecycleError('NOT_AMBIGUOUS', 'Only ambiguous orders can be reconciled.');
    } catch (e) {
      if (isUniqueViolation(e)) throw new LifecycleError('DUPLICATE_PROVIDER_ID', 'That supplier order ID is already recorded.');
      throw e;
    }
    outcome = { status: 'PENDING', refunded: false, refund: 0 };
  } else if (action === 'reject') {
    const r = rejectAndRefund({ db, orderId, fromStatus: STATUS_AMBIGUOUS, reason: 'admin_reconciled_rejected', now });
    if (!r.refunded) throw new LifecycleError('NOT_AMBIGUOUS', 'Only ambiguous orders can be reconciled.');
    outcome = { status: STATUS_REJECTED, refunded: true, refund: r.refund };
  } else {
    throw new LifecycleError('BAD_ACTION', 'Action must be accept or reject.');
  }
  logSecurity(admin.id, admin.email, `order_reconcile_${action}`, 'admin',
    JSON.stringify({ order_ref: order.order_ref, order_id: orderId, outcome: outcome.status, refunded: outcome.refunded }));
  return { ok: true, order_ref: order.order_ref, ...outcome };
}

// ---- Stale reservations ----------------------------------------------------
// A SUBMITTING row older than the timeout means the process stopped before the
// supplier outcome was recorded. The outcome is unknown, so it becomes AMBIGUOUS
// and nothing is refunded automatically.
export function sweepStaleSubmitting({ db, now = Date.now(), maxAgeMs = STALE_SUBMITTING_MS }) {
  const stale = db.prepare(
    `SELECT o.id, o.order_ref, o.provider_id, p.name AS provider_name
     FROM orders o LEFT JOIN providers p ON p.id = o.provider_id
     WHERE o.status=? AND o.created_at < ?`
  ).all(STATUS_SUBMITTING, now - maxAgeMs);
  let n = 0;
  for (const o of stale) {
    if (markAmbiguous(db, o.id, now)) {
      n++;
      alertAdmin('supplier_order_ambiguous',
        { providerId: o.provider_id, providerName: o.provider_name, orderRef: o.order_ref, category: 'ambiguous' }, now);
    }
  }
  return n;
}
