import { getDb } from '../db.js';
import { validateCommentOrder } from './commentOrder.js';
import { computePricing } from './money.js';
import { createAdapter } from './provider.js';
import { notify } from './notifier.js';
import { requestRefill, proportionalRefund, RefillError } from './orderRefill.js';
import { expireStaleDeposits } from './apirone.js';
import { logSecurity } from '../middleware/auth.js';
import {
  InsufficientBalanceError, ProviderError, DuplicateOrderError, OrderVerifyingError, LifecycleError,
  reserveOrder, settleAccepted, settleRejected, markAmbiguous, reconcileOrder, sweepStaleSubmitting,
  classifyProviderFailure, alertAdmin,
} from './orderLifecycle.js';

// The error classes live in orderLifecycle.js; they are re-exported so existing
// importers (routes, tests) keep working unchanged.
export { InsufficientBalanceError, ProviderError, DuplicateOrderError, OrderVerifyingError, LifecycleError, reconcileOrder };

// Supplier statuses that may follow an ACCEPTED order. Anything else is treated
// as PENDING so a strange supplier value can never be stored as a final state.
const ACCEPTED_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'CANCELED', 'FAILED', 'REFUNDED']);

// ---------------------------------------------------------------------------
// ORDER PLACEMENT PIPELINE  (reserve → submit → settle)
//
//  1. Pricing + balance check (all server-side, no-loss guaranteed).
//  2. RESERVE. One transaction: conditional debit, order row (SUBMITTING), ledger
//     row and coupon use. Two concurrent submissions can never both pass the same
//     balance, so the supplier is never asked for more than the customer can pay.
//  3. SUBMIT. The supplier is called once. No retry.
//  4. SETTLE.
//       accepted (supplier returned an id)  → PENDING/IN_PROGRESS, recorded once.
//       definitively refused                → REJECTED, reservation refunded once,
//                                             coupon released.
//       anything else (timeout, 5xx, bad or
//       missing reply, record failure)      → AMBIGUOUS, held for admin
//                                             reconciliation. Never refunded or
//                                             retried automatically.
// ---------------------------------------------------------------------------
function setProviderError(db, provider, category) {
  // Admin-visible, sanitized: a fixed category, never supplier text.
  db.prepare('UPDATE providers SET last_error=?, last_success_at=NULL, updated_at=? WHERE id=?')
    .run(`Order ${category}`.slice(0, 300), Date.now(), provider.id);
}

// The supplier definitively refused (or the adapter could not be built, so the
// supplier was never contacted). Refunds the reservation exactly once. Throws.
function failRejected(db, provider, orderId, orderRef, category) {
  settleRejected({ db, orderId, reason: category, now: Date.now() });
  setProviderError(db, provider, category);
  alertAdmin(category === 'insufficient_supplier_funds' ? 'supplier_insufficient_funds' : 'supplier_order_rejected',
    { providerId: provider.id, providerName: provider.name, orderRef, category });
  throw new ProviderError();
}

// The outcome is unknown. Holds the reservation for reconciliation. Throws.
function failAmbiguous(db, provider, orderId, orderRef, category) {
  markAmbiguous(db, orderId, Date.now());
  setProviderError(db, provider, category);
  alertAdmin('supplier_order_ambiguous',
    { providerId: provider.id, providerName: provider.name, orderRef, category });
  throw new OrderVerifyingError(orderRef);
}

// eslint-disable-next-line max-params
export async function placeOrder({ user, serviceId, link, quantity, couponCode = null, extras = {} }) {
  const db = getDb();
  const service = db.prepare('SELECT * FROM services WHERE id=?').get(serviceId);
  if (!service || service.status !== 1) {
    const e = new Error('Service is not available.'); e.code = 'BAD_SERVICE'; throw e;
  }
  const provider = db.prepare('SELECT * FROM providers WHERE id=? AND active=1').get(service.provider_id);
  if (!provider) { const e = new Error('Provider unavailable.'); e.code = 'BAD_PROVIDER'; throw e; }
  quantity = Math.floor(Number(quantity));
  if (!Number.isFinite(quantity) || quantity < service.min || quantity > service.max) {
    const e = new Error(`Quantity must be between ${service.min} and ${service.max}.`); e.code = 'BAD_QTY'; throw e;
  }
  if (!link || !String(link).trim()) { const e = new Error('Target link is required.'); e.code = 'BAD_LINK'; throw e; }

  // Custom comments: only 'Comments' services take them. Validated here, before
  // any wallet or provider step, so a bad comment block never debits anything.
  // Services of any other type never send a comments field.
  const commentCheck = validateCommentOrder({ serviceType: service.type, quantity, comments: extras?.comments });
  if (!commentCheck.ok) { const e = new Error(commentCheck.message); e.code = commentCheck.code; throw e; }
  extras = { ...(extras || {}) };
  if (commentCheck.text !== null) extras.comments = commentCheck.text;
  else delete extras.comments;

  // Coupon resolution + no-loss pricing (all server-side).
  const noProfit = user.no_profit === 1;
  let coupon = null;
  if (couponCode) {
    coupon = findValidCoupon(couponCode);
    if (!coupon) { const e = new Error('Invalid or expired coupon code.'); e.code = 'BAD_COUPON'; throw e; }
  }
  const pricing = computePricing({
    qty: quantity,
    adminRate: service.admin_rate,
    baseRate: service.provider_rate,
    noProfit,
    coupon,
  });
  if (coupon && pricing.price < coupon.min_order_inr) {
    const e = new Error(`Minimum order for this coupon is ${(coupon.min_order_inr / 100).toFixed(2)} INR.`); e.code = 'MIN_ORDER'; throw e;
  }

  const final = pricing.final;
  // A zero or negative price can NEVER be ordered — regardless of how
  // the service row came to be priced (a mispriced service must be
  // fixed by an admin, never exploited). Without this guard a
  // zero-priced service debits nothing (a free order) and a negative
  // price would CREDIT the wallet while placing the order (money
  // creation). The no-loss coupon clamp only guarantees final >= base;
  // it cannot protect against a non-positive base itself.
  if (!Number.isFinite(final) || final <= 0) {
    const e = new Error('This service is mispriced and cannot be ordered. Please contact support.');
    e.code = 'BAD_PRICE'; throw e;
  }
  if (quantity < 1) {
    const e = new Error('Quantity must be at least 1.'); e.code = 'BAD_QTY'; throw e;
  }
  if (user.wallet_balance < final) throw new InsufficientBalanceError();

  // STEP 2 — reserve. Debit, order row, ledger and coupon commit together, BEFORE
  // the supplier is called. Throws InsufficientBalanceError / DuplicateOrderError /
  // BAD_COUPON with nothing written.
  const linkValue = String(link).trim();
  const reserved = reserveOrder({ db, user, service, provider, quantity, link: linkValue, pricing, coupon, now: Date.now() });
  const { orderId, orderRef, newBalance } = reserved;
  user.wallet_balance = newBalance;

  // STEP 3 — submit. The supplier is called exactly once; there is no retry.
  let adapter;
  try {
    adapter = createAdapter(provider.adapter, provider);
  } catch {
    // The supplier was never contacted, so this refusal is definitive.
    failRejected(db, provider, orderId, orderRef, 'factory_error');
  }

  let routed;
  try {
    routed = await adapter.placeOrder({
      service: service.provider_service_id || String(service.id),
      link: linkValue,
      quantity,
      extras,
    });
  } catch (e) {
    const { kind, category } = classifyProviderFailure(e);
    if (kind === 'rejected') failRejected(db, provider, orderId, orderRef, category);
    failAmbiguous(db, provider, orderId, orderRef, category);
  }

  // STEP 4 — settle. Acceptance is recorded only from a supplier reply that carries
  // an order id. A reply without one may still mean the order was created.
  const providerOrderId = routed && routed.id ? String(routed.id) : '';
  if (!providerOrderId) failAmbiguous(db, provider, orderId, orderRef, 'no_reference');

  const initialStatus = (() => {
    const s = normalizeStatus(routed.status || 'PENDING');
    return ACCEPTED_STATUSES.has(s) ? s : 'PENDING';
  })();

  let settled;
  try {
    settled = settleAccepted({
      db, orderId, providerOrderId, initialStatus,
      charge: routed.charge == null ? NaN : Number(routed.charge),
      currency: routed.currency || provider.currency || null,
      now: Date.now(),
    });
  } catch {
    failAmbiguous(db, provider, orderId, orderRef, 'record_failed');
  }
  if (!settled.ok) failAmbiguous(db, provider, orderId, orderRef, settled.category);

  db.prepare('UPDATE providers SET last_success_at=?, last_error=NULL, updated_at=? WHERE id=?')
    .run(Date.now(), Date.now(), provider.id);

  try {
    notify(user.id, 'order', 'Order Created',
      `#${orderRef} — ${service.name} × ${quantity}. Accepted by supplier, ${initialStatus.replace('_', ' ')}.`);
  } catch { /* never block on a notification */ }

  return orderWithService(db, orderId);
}

function findValidCoupon(code) {
  const db = getDb();
  const now = Date.now();
  const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(String(code).trim().toUpperCase());
  if (!c || c.active !== 1) return null;
  if (c.starts_at && now < c.starts_at) return null;
  if (c.expires_at && now > c.expires_at) return null;
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return null;
  return c;
}

// Returns queue for "Any" order's current provider interaction. Public face of
// coupon verification used by GET /api/quote BEFORE payment.
export function quoteOrder({ serviceId, quantity, couponCode, noProfit }) {
  const db = getDb();
  const service = db.prepare('SELECT * FROM services WHERE id=?').get(serviceId);
  if (!service || service.status !== 1) { const e = new Error('Service unavailable.'); e.code = 'BAD_SERVICE'; throw e; }
  quantity = Math.floor(Number(quantity));
  if (!Number.isFinite(quantity) || quantity < service.min || quantity > service.max) {
    const e = new Error(`Quantity must be between ${service.min} and ${service.max}.`); e.code = 'BAD_QTY'; throw e;
  }
  const coupon = couponCode ? findValidCoupon(couponCode) : null;
  const pricing = computePricing({ qty: quantity, adminRate: service.admin_rate, baseRate: service.provider_rate, noProfit, coupon });
  const invalidCoupon = couponCode && !coupon;
  const belowMin = coupon && pricing.price < coupon.min_order_inr;
  // Return ONLY display-safe fields — never base/provider rate, never clamp math.
  return {
    ok: true,
    serviceId: service.id,
    quantity,
    price: pricing.price,
    discount: pricing.discount,
    final: pricing.final,
    coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value } : null,
    invalidCoupon: Boolean(invalidCoupon),
    belowMin: Boolean(belowMin),
  };
}

// ---------------------------------------------------------------------------
// STATUS TICKER — keeps demo orders moving and syncs real providers.
// ---------------------------------------------------------------------------
let tickerStarted = false;
const TICK_MS = 10_000;

export function startOrderTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  const run = () => {
    Promise.resolve(syncOrderStatuses()).catch((e) => console.error('[instasmm] order tick error:', e.message));
    try { expireStaleDeposits(); } catch { /* noop */ }
  };
  run();
  setInterval(run, TICK_MS);
  console.log(`[instasmm] Order sync ticker active (every ${TICK_MS / 1000}s)`);
}

export async function syncOrderStatuses() {
  const db = getDb();
  // Reservations left in SUBMITTING by a stopped process become AMBIGUOUS (held,
  // never refunded automatically). Done before the sync so they are not synced.
  try { sweepStaleSubmitting({ db }); } catch (e) { console.error('[instasmm] stale-order sweep error:', e.message); }
  // No JOIN to services: the provider order id lives on the order row, so
  // an order whose service was later deleted (detached) must STILL be
  // synced — otherwise it would be stuck PENDING/IN_PROGRESS forever.
  const active = db.prepare(
    `SELECT o.* FROM orders o
     WHERE o.status IN ('PENDING','IN_PROGRESS')`
  ).all();

  // Group per provider so actions that support batch status (smmpost
  // action=status, orders="1,2,3") hit the API once per tick.
  const byProvider = new Map();
  for (const order of active) {
    const provider = db.prepare('SELECT * FROM providers WHERE id=?').get(order.provider_id);
    if (!provider) continue;
    if (!byProvider.has(provider.id)) byProvider.set(provider.id, { provider, orders: [] });
    byProvider.get(provider.id).orders.push(order);
  }

  for (const { provider, orders } of byProvider.values()) {
    let adapter;
    try {
      adapter = createAdapter(provider.adapter, provider);
    } catch (e) { continue; }

    // Batch path when the adapter exposes it (returns Map<order.id, status>).
    let batch = null;
    try {
      if (typeof adapter.batchStatuses === 'function') batch = await adapter.batchStatuses(orders, provider);
    } catch (e) { continue; } // upstream down — retry next tick, never fabricate.

    if (batch instanceof Map) {
      for (const order of orders) {
        const st = batch.get(order.id);
        if (st) applySyncResult(db, order, st);
      }
      continue;
    }

    // Fallback: one status call per order (works for every adapter).
    for (const order of orders) {
      try {
        const st = await adapter.orderStatus(order.provider_order_id || order.order_ref, order);
        applySyncResult(db, order, st);
      } catch (e) { /* transient — retry next tick */ }
    }
  }
}

// Apply one sync result to an order row, notifying the user on status CHANGE.
function applySyncResult(db, order, st) {
  if (!st || typeof st !== 'object') return;
  const changed =
    (st.startCount != null && st.startCount !== order.start_count) ||
    (st.remains != null && st.remains !== order.remains) ||
    String(st.status ?? '').toUpperCase() !== order.status ||
    (st.charge != null && Number(st.charge) !== Number(order.provider_charge)) ||
    (st.currency && String(st.currency) !== String(order.provider_currency || ''));
  if (!changed) return;

  const status = normalizeStatus(st.status);
  const charge = Number.isFinite(Number(st.charge)) ? Number(st.charge) : order.provider_charge;
  const currency = st.currency && String(st.currency) !== 'undefined' ? String(st.currency) : order.provider_currency;
  const startCount = Number.isFinite(Number(st.startCount)) ? Number(st.startCount) : order.start_count;
  const remains = Number.isFinite(Number(st.remains)) ? Number(st.remains) : order.remains;
  db.prepare(
    `UPDATE orders SET status=?, start_count=?, remains=?, provider_charge=?, provider_currency=?, updated_at=? WHERE id=?`
  ).run(status, startCount, remains, charge, currency, Date.now(), order.id);

  if (status !== order.status) {
    const user = db.prepare('SELECT id FROM users WHERE id=?').get(order.user_id);
    if (user) {
      notify(user.id, 'order', `Order Update • ${status}`,
        `#${order.order_ref} is now ${status.replace('_', ' ')}${remains > 0 ? ` (${remains} remaining)` : ''}.`);
    }
  }
}

function normalizeStatus(s) {
  s = String(s).toUpperCase().replace(/\s+/g, '_');
  const map = {
    COMPLETE: 'COMPLETED',
    PROCESSING: 'IN_PROGRESS',
    IN_PROGRESS: 'IN_PROGRESS',
    PENDING: 'PENDING',
    PARTIAL: 'PARTIAL',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
  };
  return map[s] || (s.includes('COMPLETE') ? 'COMPLETED' : s);
}

// ---------------------------------------------------------------------------
// ADMIN cancel / refill — only when the provider caps + the service advertises
// support. We call the REAL adapter; a provider error is surfaced (502), never
// faked. Cancel refunds the unused portion (remains/qty × price) into the
// wallet only when some quantity was not yet delivered.
// ---------------------------------------------------------------------------
export async function cancelOrder({ admin, orderId }) {
  const db = getDb();
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) { const e = new Error('Order not found.'); e.code = '404'; throw e; }
  if (!['PENDING', 'IN_PROGRESS'].includes(o.status)) {
    const e = new Error('Only pending/in-progress orders can be canceled.'); e.code = 'BAD_STATUS'; throw e;
  }
  const provider = db.prepare('SELECT * FROM providers WHERE id=?').get(o.provider_id);
  if (!provider) { const e = new Error('Provider not found.'); e.code = '404'; throw e; }
  const service = db.prepare('SELECT * FROM services WHERE id=?').get(o.service_id);
  const supportsCancel = service?.cancel === 1;

  let upstream;
  try {
    upstream = await createAdapter(provider.adapter, provider).cancel(o.provider_order_id || o.order_ref);
  } catch (e) {
    db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?').run(String(e.message).slice(0, 300), Date.now(), provider.id);
    const err = new ProviderError(`Provider refused the cancel: ${e.message}`); throw err;
  }

  // An accepted cancel request is NOT proof that the supplier cancelled the order.
  // Confirm the supplier's own status and unused quantity before any refund. If that
  // cannot be confirmed, nothing is refunded and the attempt is logged for review.
  let confirmed = null;
  try {
    confirmed = await createAdapter(provider.adapter, provider).orderStatus(o.provider_order_id || o.order_ref);
  } catch { confirmed = null; }
  const confirmedStatus = confirmed ? normalizeStatus(String(confirmed.status || '')) : null;
  const confirmedRemains = confirmed ? Math.trunc(Number(confirmed.remains)) : NaN;
  const cancelConfirmed = confirmedStatus === 'CANCELED'
    && Number.isFinite(confirmedRemains) && confirmedRemains >= 0 && confirmedRemains <= o.quantity;
  if (!cancelConfirmed) {
    logSecurity(admin?.id, admin?.email, 'cancel_unconfirmed', 'admin');
    throw new ProviderError('The supplier did not confirm the cancellation. Nothing was refunded and the order was not changed. Check the supplier before retrying.');
  }

  const now = Date.now();
  const remains = confirmedRemains;
  // Refund = price × supplier-confirmed unused ÷ quantity (integer paise, half-up).
  const refundInr = supportsCancel ? proportionalRefund(o.price_inr, o.quantity, remains) : 0;

  db.exec('BEGIN');
  try {
    // ATOMIC CLAIM. Only the transaction that moves the order out of
    // PENDING/IN_PROGRESS may refund. A concurrent cancel that read the same
    // status before our await changes 0 rows here and refunds nothing.
    const claim = db.prepare(
      "UPDATE orders SET status='CANCELED', remains=?, updated_at=? WHERE id=? AND status IN ('PENDING','IN_PROGRESS')"
    ).run(remains, now, o.id);
    if (claim.changes !== 1) {
      const e = new Error('Only pending/in-progress orders can be canceled.'); e.code = 'BAD_STATUS';
      throw e;   // the catch below rolls back
    }
    if (refundInr > 0) {
      // Atomic arithmetic: never a read-modify-write of the balance.
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?').run(refundInr, o.user_id);
      const newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(o.user_id).wallet_balance);
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
         VALUES (?, 'refund', ?, ?, ?, ?, ?)`
      ).run(o.user_id, refundInr, newBalance, o.id, JSON.stringify({ order: o.order_ref, reason: 'cancel', remains }), now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  logSecurity(admin?.id, admin?.email, 'cancel_order', 'admin');
  notify(o.user_id, 'order', 'Order Canceled',
    `#${o.order_ref} was canceled${refundInr > 0 ? ` — ${(refundInr / 100).toFixed(2)} INR refunded.` : '.'}`);
  return { ok: true, status: 'CANCELED', refund_inr: refundInr };
}

export async function refillOrder({ admin, orderId }) {
  const db = getDb();
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) { const e = new Error('Order not found.'); e.code = '404'; throw e; }
  const provider = db.prepare('SELECT * FROM providers WHERE id=?').get(o.provider_id);
  if (!provider) { const e = new Error('Provider not found.'); e.code = '404'; throw e; }
  const service = db.prepare('SELECT * FROM services WHERE id=?').get(o.service_id);
  // Admin refill goes through the same audited request path as customer refill. The
  // order's status and remains are NOT changed: a refill is a separate supplier order.
  try {
    return await requestRefill({ db, order: o, service, provider, actor: 'admin', userId: admin?.id });
  } catch (e) {
    if (e instanceof RefillError) {
      const err = new Error(e.message);
      err.code = e.code === 'REFILL_NOT_SUPPORTED' ? 'NO_REFILL' : e.code === 'NOT_FOUND' ? '404' : 'PROVIDER_ERROR';
      throw err;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Order masks (never expose base cost / discount mechanics / supplier order
// ids to clients — Task 8: a client must never learn the supplier's id).
// ---------------------------------------------------------------------------
export function orderWithService(db, orderId) {
  const o = db.prepare(
    `SELECT o.order_ref AS order_ref, o.id, o.user_id, o.service_id, o.link, o.quantity,
            o.price_inr, o.discount_inr, o.status, o.start_count, o.remains,
            o.created_at, o.coupon_id,
            s.name AS service_name, s.description AS service_description, s.speed_hint, s.min, s.max,
            c.name AS category_name,
            COALESCE(s.refill, 0) AS refill_supported,
            (SELECT r.status FROM order_refill_requests r WHERE r.order_id = o.id ORDER BY r.id DESC LIMIT 1) AS refill_status
     FROM orders o
     LEFT JOIN services s ON s.id = o.service_id
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE o.id=?`).get(orderId);
  if (!o) return null;
  const { base_cost_inr: _bc, ...masked } = o; // safety (not in projection anyway)
  return masked;
}

export function userOrders(db, userId) {
  return db.prepare(
    `SELECT o.order_ref, o.id, o.service_id, o.link, o.quantity, o.price_inr, o.discount_inr,
            o.status, o.start_count, o.remains, o.created_at,
            s.name AS service_name, s.speed_hint, c.name AS category_name,
            COALESCE(s.refill, 0) AS refill_supported,
            (SELECT r.status FROM order_refill_requests r WHERE r.order_id = o.id ORDER BY r.id DESC LIMIT 1) AS refill_status
     FROM orders o
     LEFT JOIN services s ON s.id = o.service_id
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 200`
  ).all(userId);
}