// ---------------------------------------------------------------------------
// Refill requests and proportional refund arithmetic.
//
// Refill: a refill is a NEW supplier request, not a change to the existing
// order. The supplier must return a refill id before anything is recorded as
// accepted. A reply without an id, a timeout, or a malformed reply is held as
// AMBIGUOUS and blocks further refills until it is reviewed. The order's status
// and remains are never changed by a refill.
//
// Refund: refund = price × unused ÷ quantity, computed in integer paise with
// half-up rounding and never more than the price paid.
// ---------------------------------------------------------------------------
import { createAdapter } from './provider.js';
import { notify } from './notifier.js';
import { logSecurity } from '../middleware/auth.js';

export const REFILL_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  AMBIGUOUS: 'AMBIGUOUS',
});

// ASSUMPTION, not verified against supplier documentation: customers may request a
// refill only after delivery has started or finished. Owner must confirm the rule.
export const CUSTOMER_REFILL_ORDER_STATUSES = Object.freeze(['COMPLETED', 'PARTIAL']);

export class RefillError extends Error {
  constructor(code, message, http) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

// Integer, half-up rounding. Exact with BigInt, so no floating-point drift.
// Example: 1000 paise for 1000 units with 900 unused → 900 paise (₹9).
export function proportionalRefund(priceInr, quantity, unusedQuantity) {
  const price = Math.trunc(Number(priceInr));
  const qty = Math.trunc(Number(quantity));
  const unusedRaw = Math.trunc(Number(unusedQuantity));
  if (!Number.isFinite(price) || price < 0) throw new RangeError('price must be a non-negative integer');
  if (!Number.isFinite(qty) || qty <= 0) throw new RangeError('quantity must be a positive integer');
  const unused = Math.min(qty, Math.max(0, Number.isFinite(unusedRaw) ? unusedRaw : 0));
  if (unused === 0 || price === 0) return 0;
  const num = BigInt(price) * BigInt(unused);
  const den = BigInt(qty);
  const refund = Number((2n * num + den) / (2n * den)); // round half up
  return Math.min(price, refund);
}

// The supplier must return a refill id. Accept only a short, non-empty value.
export function extractRefillId(upstream) {
  const v = upstream && typeof upstream === 'object' ? (upstream.refill ?? upstream.id) : undefined;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s && s.length <= 64 ? s : null;
}

function setRefillOutcome(db, orderId, status, providerRefillId, reason, now) {
  db.prepare(
    "UPDATE order_refill_requests SET status=?, provider_refill_id=?, reason=?, updated_at=? WHERE order_id=? AND status='REQUESTED'"
  ).run(status, providerRefillId, reason, now, orderId);
}

// Single entry point for customer and admin refills.
//   customer: must own the order, order must be COMPLETED/PARTIAL, and no refill may
//             be ACCEPTED, REQUESTED or AMBIGUOUS for it (one customer refill per order).
//   admin:    may refill any order on a refill-capable service; blocked only while a
//             refill is REQUESTED or AMBIGUOUS.
// Returns { ok, status }. Never returns the supplier id.
export async function requestRefill({ db, order, service, provider, actor, userId, now = Date.now() }) {
  if (actor !== 'customer' && actor !== 'admin') throw new RangeError('actor must be customer or admin');
  if (actor === 'customer' && order.user_id !== userId) {
    throw new RefillError('NOT_FOUND', 'Order not found.', 404);
  }
  if (!service || Number(service.refill) !== 1) {
    throw new RefillError('REFILL_NOT_SUPPORTED', 'This service does not offer refill.', 409);
  }
  if (actor === 'customer' && !CUSTOMER_REFILL_ORDER_STATUSES.includes(order.status)) {
    throw new RefillError('REFILL_NOT_AVAILABLE',
      'Refill is available once an order has been completed or partly delivered.', 409);
  }
  if (!order.provider_order_id) {
    throw new RefillError('REFILL_NOT_AVAILABLE', 'This order has no supplier reference yet.', 409);
  }
  if (!provider || Number(provider.active) !== 1) {
    throw new RefillError('PROVIDER_UNAVAILABLE', 'The supplier for this order is unavailable right now.', 409);
  }

  const blocking = actor === 'customer'
    ? "('REQUESTED','AMBIGUOUS','ACCEPTED')"
    : "('REQUESTED','AMBIGUOUS')";

  // Claim first, in its own transaction. The NOT EXISTS guard and the partial unique
  // index both stop a second in-flight request, including a concurrent one.
  db.exec('BEGIN');
  try {
    const existing = db.prepare(
      `SELECT status FROM order_refill_requests WHERE order_id=? AND status IN ${blocking} ORDER BY id DESC LIMIT 1`
    ).get(order.id);
    if (existing) {
      const msg = existing.status === REFILL_STATUS.ACCEPTED
        ? 'A refill has already been requested for this order.'
        : 'A refill for this order is already being processed. Please wait before trying again.';
      throw new RefillError('REFILL_ALREADY_REQUESTED', msg, 409);
    }
    const r = db.prepare(
      `INSERT INTO order_refill_requests (order_id, user_id, status, created_at, updated_at)
       SELECT ?, ?, 'REQUESTED', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM order_refill_requests WHERE order_id=? AND status IN ${blocking})`
    ).run(order.id, order.user_id, now, now, order.id);
    if (r.changes !== 1) throw new RefillError('REFILL_ALREADY_REQUESTED', 'A refill for this order is already being processed.', 409);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    if (e instanceof RefillError) throw e;
    if (/UNIQUE|23505/i.test(`${e.message} ${e.code || ''}`)) {
      throw new RefillError('REFILL_ALREADY_REQUESTED', 'A refill for this order is already being processed.', 409);
    }
    throw e;
  }

  // Supplier call happens after the claim is committed. Never retried here.
  let upstream;
  try {
    upstream = await createAdapter(provider.adapter, provider).refill(order.provider_order_id);
  } catch (e) {
    if (e && e.kind === 'rejected') {
      setRefillOutcome(db, order.id, REFILL_STATUS.REJECTED, null, e.category || 'provider_rejected', Date.now());
      logSecurity(actor === 'admin' ? userId : order.user_id, null, 'refill_rejected', actor);
      throw new RefillError('REFILL_REJECTED', 'The supplier did not accept the refill request. Nothing has changed.', 409);
    }
    setRefillOutcome(db, order.id, REFILL_STATUS.AMBIGUOUS, null, e?.category || 'unknown', Date.now());
    logSecurity(actor === 'admin' ? userId : order.user_id, null, 'refill_ambiguous', actor);
    throw new RefillError('REFILL_UNCONFIRMED',
      'The refill could not be confirmed. It has been flagged for review. Please do not submit it again.', 502);
  }

  const providerRefillId = extractRefillId(upstream);
  if (!providerRefillId) {
    setRefillOutcome(db, order.id, REFILL_STATUS.AMBIGUOUS, null, 'no_refill_id', Date.now());
    logSecurity(actor === 'admin' ? userId : order.user_id, null, 'refill_ambiguous', actor);
    throw new RefillError('REFILL_UNCONFIRMED',
      'The refill could not be confirmed. It has been flagged for review. Please do not submit it again.', 502);
  }

  setRefillOutcome(db, order.id, REFILL_STATUS.ACCEPTED, providerRefillId, null, Date.now());
  logSecurity(actor === 'admin' ? userId : order.user_id, null, 'refill_accepted', actor);
  notify(order.user_id, 'order', 'Refill requested',
    `A refill request for #${order.order_ref} was accepted by the supplier.`);
  return { ok: true, status: REFILL_STATUS.ACCEPTED };
}
