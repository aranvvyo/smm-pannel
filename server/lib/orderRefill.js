// ---------------------------------------------------------------------------
// Refill requests (customer and admin).
//
// A refill is a NEW supplier request for an existing supplier order, using the
// standard SMM API v2 contract:
//   refill        {action:'refill', order:<supplier order id>}   -> {refill: <id>}
//   refill_status {action:'refill_status', refill:<refill id>}   -> {status: <text>}
//
// Rules enforced here, on the server, for every request:
//   - the order belongs to the caller (customers) and the service advertises refill;
//   - the supplier order id is the one the supplier returned (provider_order_id).
//     There is NO fallback to the internal order_ref, which is not a supplier id;
//   - at most one refill is in flight per order, including concurrent clicks;
//   - a refill is ACCEPTED only when the supplier returns a refill id. A reply without
//     an id, a timeout, or a malformed reply is AMBIGUOUS and blocks further refills
//     until it is reviewed. The order's status, remains and charges are not changed.
//
// Eligibility is computed on the server and returned to the client. The client
// never decides eligibility on its own.
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

// ASSUMPTION, not confirmed against the configured supplier's documentation:
// customers may request a refill only once delivery has started or finished.
export const CUSTOMER_REFILL_ORDER_STATUSES = Object.freeze(['COMPLETED', 'PARTIAL']);

// Minimum time between supplier status checks for the same refill request.
export const REFILL_STATUS_COOLDOWN_MS = 60_000;

// Gate for EVERY real supplier call (refill and refill_status). Off unless the server
// sets REFILL_ENABLED=1. Keep it off until the configured supplier's refill documentation
// has been confirmed. Read at call time so a restart is not needed to test it.
export function refillEnabled() {
  return process.env.REFILL_ENABLED === '1';
}
export const REFILL_DISABLED_MESSAGE = 'Refill is not enabled on this server yet.';

// A REQUESTED claim older than this is assumed abandoned (the process stopped during the
// supplier call). It is moved to AMBIGUOUS for review and is NEVER resubmitted automatically.
// It is longer than the supplier timeout (15 s), so a live call is never swept.
export const REFILL_STALE_CLAIM_MS = 10 * 60 * 1000;

export class RefillError extends Error {
  constructor(code, message, http) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

// The supplier must return a refill id. Accept only a short, non-empty value.
export function extractRefillId(upstream) {
  const v = upstream && typeof upstream === 'object' ? (upstream.refill ?? upstream.id) : undefined;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s && s.length <= 64 ? s : null;
}

// Supplier status text is shown to the customer as provided. Only control characters
// are removed and the length is capped. Nothing is mapped or renamed.
export function cleanSupplierStatus(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) || null;
}

function latestRequest(db, orderId) {
  return db.prepare('SELECT * FROM order_refill_requests WHERE order_id=? ORDER BY id DESC LIMIT 1').get(orderId) || null;
}

function loadContext(db, order) {
  const service = order.service_id
    ? db.prepare('SELECT id, refill FROM services WHERE id=?').get(order.service_id) : null;
  const provider = order.provider_id
    ? db.prepare('SELECT id, adapter, api_url, api_key, active FROM providers WHERE id=?').get(order.provider_id) : null;
  return { service, provider };
}

// Whether the latest request stops a NEW request by this actor.
//   customer: any REQUESTED, AMBIGUOUS, or ACCEPTED request. An ACCEPTED request the
//             supplier later reports as "Rejected" no longer blocks, because the
//             supplier has said the refill did not happen.
//   admin:    only REQUESTED or AMBIGUOUS, so an operator can run a further refill.
function isBlocking(row, actor) {
  if (!row) return false;
  if (row.status === REFILL_STATUS.REQUESTED || row.status === REFILL_STATUS.AMBIGUOUS) return true;
  if (actor === 'customer' && row.status === REFILL_STATUS.ACCEPTED) {
    return String(row.provider_status || '').trim().toLowerCase() !== 'rejected';
  }
  return false;
}

function blockedReason(row) {
  if (row.status === REFILL_STATUS.AMBIGUOUS) {
    return 'A previous refill for this order could not be confirmed and is being reviewed. Please contact support.';
  }
  if (row.status === REFILL_STATUS.REQUESTED) {
    return 'A refill for this order is already being processed. Please check back shortly.';
  }
  return 'A refill has already been requested for this order.';
}

// Server-side eligibility for one order, for the given actor.
// Returns { supported, eligible, reason, status, supplier_status, checked_at }.
// Never returns supplier ids, keys or raw supplier responses.
export function refillEligibility({ db, order, actor = 'customer' }) {
  const latest = latestRequest(db, order.id);
  const { service, provider } = loadContext(db, order);
  const summary = {
    supported: false,
    eligible: false,
    reason: null,
    status: latest ? latest.status : null,
    supplier_status: latest ? latest.provider_status || null : null,
    checked_at: latest ? latest.provider_checked_at || null : null,
  };
  if (!service || Number(service.refill) !== 1) {
    return { ...summary, reason: 'This service does not offer refill.' };
  }
  summary.supported = true;
  if (!refillEnabled()) return { ...summary, reason: REFILL_DISABLED_MESSAGE };
  if (actor === 'customer' && !CUSTOMER_REFILL_ORDER_STATUSES.includes(order.status)) {
    return { ...summary, reason: 'Refill is available once your order has been completed or partly delivered.' };
  }
  if (!order.provider_order_id) {
    return { ...summary, reason: 'This order has no supplier reference yet.' };
  }
  if (!provider || Number(provider.active) !== 1) {
    return { ...summary, reason: 'The supplier for this order is unavailable right now.' };
  }
  if (isBlocking(latest, actor)) {
    return { ...summary, reason: blockedReason(latest) };
  }
  return { ...summary, eligible: true, reason: null };
}

// Eligibility for every order of one customer, keyed by internal order id. The query
// reads the supplier order id here, in the refill module, so the customer routes never
// touch supplier identifiers.
export function refillSummariesForUser(db, userId, limit = 200) {
  const rows = db.prepare(
    "SELECT id, user_id, service_id, provider_id, provider_order_id, order_ref, status FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?"
  ).all(userId, limit);
  const byId = new Map();
  for (const row of rows) byId.set(Number(row.id), refillEligibility({ db, order: row, actor: "customer" }));
  return byId;
}

// Submit a refill for one order.
//   actor 'customer': userId must own the order.
//   actor 'admin':    no ownership check.
// Returns { ok: true, status: 'ACCEPTED' } or throws RefillError.
export async function requestRefill({ db, order, actor, userId, now = Date.now() }) {
  if (actor !== 'customer' && actor !== 'admin') throw new RangeError('actor must be customer or admin');
  if (!refillEnabled()) throw new RefillError('REFILL_DISABLED', REFILL_DISABLED_MESSAGE, 503);
  if (actor === 'customer' && order.user_id !== userId) {
    throw new RefillError('NOT_FOUND', 'Order not found.', 404);
  }
  const { service, provider } = loadContext(db, order);
  if (!service || Number(service.refill) !== 1) {
    throw new RefillError('REFILL_NOT_SUPPORTED', 'This service does not offer refill.', 409);
  }
  if (actor === 'customer' && !CUSTOMER_REFILL_ORDER_STATUSES.includes(order.status)) {
    throw new RefillError('REFILL_NOT_AVAILABLE',
      'Refill is available once your order has been completed or partly delivered.', 409);
  }
  if (!order.provider_order_id) {
    throw new RefillError('REFILL_NOT_AVAILABLE', 'This order has no supplier reference yet.', 409);
  }
  if (!provider || Number(provider.active) !== 1) {
    throw new RefillError('PROVIDER_UNAVAILABLE', 'The supplier for this order is unavailable right now.', 409);
  }

  // Claim first, in its own transaction. The pre-check and the guarded INSERT (with the
  // partial unique index on in-flight rows) together stop a second concurrent request.
  let claimId;
  // Recover abandoned claims first, as their own statements. A blocked request throws and
  // rolls back, so the sweep must not depend on the transaction.
  sweepStaleClaims(db, now);
  db.exec('BEGIN');
  try {
    const latest = latestRequest(db, order.id);
    if (isBlocking(latest, actor)) {
      throw new RefillError('REFILL_ALREADY_REQUESTED', blockedReason(latest), 409);
    }
    const r = db.prepare(
      `INSERT INTO order_refill_requests (order_id, user_id, status, created_at, updated_at)
       SELECT ?, ?, 'REQUESTED', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM order_refill_requests WHERE order_id=? AND status IN ('REQUESTED','AMBIGUOUS'))`
    ).run(order.id, order.user_id, now, now, order.id);
    if (r.changes !== 1) {
      throw new RefillError('REFILL_ALREADY_REQUESTED', 'A refill for this order is already being processed.', 409);
    }
    // Read the claimed row back by order. lastInsertRowid is not reliable for
    // INSERT ... SELECT on every database dialect.
    claimId = Number(latestRequest(db, order.id)?.id);
    if (!claimId) throw new RefillError('REFILL_ALREADY_REQUESTED', 'A refill for this order is already being processed.', 409);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    if (e instanceof RefillError) throw e;
    if (/UNIQUE|23505/i.test(`${e.message} ${e.code || ''}`)) {
      throw new RefillError('REFILL_ALREADY_REQUESTED', 'A refill for this order is already being processed.', 409);
    }
    throw e;
  }

  const setOutcome = (status, providerRefillId, reason) => {
    db.prepare('UPDATE order_refill_requests SET status=?, provider_refill_id=?, reason=?, updated_at=? WHERE id=?')
      .run(status, providerRefillId, reason, Date.now(), claimId);
  };
  const actorId = actor === 'admin' ? userId : order.user_id;

  // Supplier call happens after the claim is committed. It is never retried here.
  let upstream;
  try {
    upstream = await createAdapter(provider.adapter, provider).refill(order.provider_order_id);
  } catch (e) {
    if (e && e.kind === 'rejected') {
      setOutcome(REFILL_STATUS.REJECTED, null, e.category || 'provider_rejected');
      logSecurity(actorId, null, 'refill_rejected', actor);
      throw new RefillError('REFILL_REJECTED', 'The supplier did not accept the refill request. Nothing has changed.', 409);
    }
    setOutcome(REFILL_STATUS.AMBIGUOUS, null, e?.category || 'unknown');
    logSecurity(actorId, null, 'refill_ambiguous', actor);
    throw new RefillError('REFILL_UNCONFIRMED',
      'The refill could not be confirmed. It has been flagged for review. Please do not submit it again.', 502);
  }

  const providerRefillId = extractRefillId(upstream);
  if (!providerRefillId) {
    setOutcome(REFILL_STATUS.AMBIGUOUS, null, 'no_refill_id');
    logSecurity(actorId, null, 'refill_ambiguous', actor);
    throw new RefillError('REFILL_UNCONFIRMED',
      'The refill could not be confirmed. It has been flagged for review. Please do not submit it again.', 502);
  }

  setOutcome(REFILL_STATUS.ACCEPTED, providerRefillId, null);
  logSecurity(actorId, null, 'refill_accepted', actor);
  notify(order.user_id, 'order', 'Refill requested',
    `A refill request for #${order.order_ref} was accepted by the supplier.`);
  return { ok: true, status: REFILL_STATUS.ACCEPTED };
}

// Ask the supplier for the status of the latest accepted refill. Rate-limited per
// request by REFILL_STATUS_COOLDOWN_MS. The supplier's text is stored unchanged.
export async function checkRefillStatus({ db, order, now = Date.now() }) {
  if (!refillEnabled()) throw new RefillError('REFILL_DISABLED', REFILL_DISABLED_MESSAGE, 503);
  const row = latestRequest(db, order.id);
  if (!row || row.status !== REFILL_STATUS.ACCEPTED || !row.provider_refill_id) {
    throw new RefillError('REFILL_NOT_CHECKABLE', 'There is no accepted refill to check for this order.', 409);
  }
  if (row.provider_checked_at && now - row.provider_checked_at < REFILL_STATUS_COOLDOWN_MS) {
    return { supplier_status: row.provider_status || null, checked_at: row.provider_checked_at, cached: true };
  }
  const { provider } = loadContext(db, order);
  if (!provider || Number(provider.active) !== 1) {
    throw new RefillError('PROVIDER_UNAVAILABLE', 'The supplier for this order is unavailable right now.', 409);
  }
  const adapter = createAdapter(provider.adapter, provider);
  if (typeof adapter.refillStatus !== 'function') {
    throw new RefillError('STATUS_UNSUPPORTED', 'This supplier does not report refill status.', 409);
  }
  let out;
  try {
    out = await adapter.refillStatus(row.provider_refill_id);
  } catch {
    // The supplier's message is never shown to the customer.
    throw new RefillError('STATUS_UNAVAILABLE', 'The refill status could not be retrieved right now. Please try again later.', 502);
  }
  const text = cleanSupplierStatus(out?.status ?? '');
  if (!text) {
    throw new RefillError('STATUS_UNAVAILABLE', 'The refill status could not be retrieved right now. Please try again later.', 502);
  }
  db.prepare('UPDATE order_refill_requests SET provider_status=?, provider_checked_at=?, updated_at=? WHERE id=?')
    .run(text, now, now, row.id);
  return { supplier_status: text, checked_at: now, cached: false };
}

// Moves REQUESTED claims older than REFILL_STALE_CLAIM_MS to AMBIGUOUS. It never calls the
// supplier. The row keeps blocking new refills until an admin reviews it.
export function sweepStaleClaims(db, now = Date.now()) {
  const cutoff = now - REFILL_STALE_CLAIM_MS;
  const stale = db.prepare("SELECT id, user_id FROM order_refill_requests WHERE status='REQUESTED' AND created_at < ?").all(cutoff);
  for (const row of stale) {
    const r = db.prepare("UPDATE order_refill_requests SET status='AMBIGUOUS', reason='stale_claim', updated_at=? WHERE id=? AND status='REQUESTED'").run(now, row.id);
    if (r.changes === 1) logSecurity(null, null, 'refill_stale_claim', 'system');
  }
  return stale.length;
}

// Admin review of an AMBIGUOUS or abandoned refill. Only after the admin has checked the
// supplier by hand. "accepted" needs the supplier's refill id. "not_accepted" records that
// the supplier confirms no refill was created. Nothing is sent to the supplier here.
export function resolveRefillReview({ db, orderId, adminId, decision, refillId = null, note, now = Date.now() }) {
  if (decision !== 'accepted' && decision !== 'not_accepted') {
    throw new RefillError('BAD_DECISION', 'Decision must be accepted or not_accepted.', 400);
  }
  const cleanNote = String(note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (cleanNote.length < 5 || cleanNote.length > 300) {
    throw new RefillError('BAD_NOTE', 'Add a short note (5 to 300 characters) describing the supplier check.', 400);
  }
  let id = null;
  if (decision === 'accepted') {
    id = extractRefillId({ refill: refillId });
    if (!id) throw new RefillError('BAD_REFILL_ID', 'Enter the supplier refill id exactly as the supplier shows it.', 400);
  }
  const row = latestRequest(db, orderId);
  if (!row) throw new RefillError('NOT_IN_REVIEW', 'This order has no refill waiting for review.', 409);
  if (row.status === REFILL_STATUS.REQUESTED && row.created_at >= now - REFILL_STALE_CLAIM_MS) {
    throw new RefillError('NOT_IN_REVIEW', 'This refill is still being processed. Try again later.', 409);
  }
  if (row.status !== REFILL_STATUS.AMBIGUOUS && row.status !== REFILL_STATUS.REQUESTED) {
    throw new RefillError('NOT_IN_REVIEW', 'This order has no refill waiting for review.', 409);
  }
  const status = decision === 'accepted' ? REFILL_STATUS.ACCEPTED : REFILL_STATUS.REJECTED;
  const reason = `admin_review:${decision}: ${cleanNote}`.slice(0, 300);
  db.exec('BEGIN');
  try {
    const r = db.prepare("UPDATE order_refill_requests SET status=?, provider_refill_id=?, reason=?, updated_at=? WHERE id=? AND status IN ('AMBIGUOUS','REQUESTED')")
      .run(status, id, reason, now, row.id);
    if (r.changes !== 1) throw new RefillError('NOT_IN_REVIEW', 'This refill was already reviewed.', 409);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw e;
  }
  logSecurity(adminId, null, `refill_review_${decision}`, 'admin');
  return { ok: true, status };
}
