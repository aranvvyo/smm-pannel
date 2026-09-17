import { getDb, newId } from '../db.js';
import { computePricing } from './money.js';
import { createAdapter } from './provider.js';
import { notify } from './notifier.js';
import { expireStaleDeposits } from './apirone.js';
import { logSecurity } from '../middleware/auth.js';

export class InsufficientBalanceError extends Error {
  constructor(message = 'Insufficient balance') { super(message); this.code = 'INSUFFICIENT_BALANCE'; }
}
export class ProviderError extends Error {
  constructor(message = 'Provider error') { super(message); this.code = 'PROVIDER_ERROR'; }
}

// ---------------------------------------------------------------------------
// ORDER PLACEMENT PIPELINE  (provider-first)
//
//  1. Pricing + balance check (all server-side, no-loss guaranteed).
//  2. ROUTE TO PROVIDER FIRST. If upstream rejects or is unreachable we throw
//     ProviderError BEFORE touching the wallet — no debit, no order row, and
//     the real error is surfaced to the UI. We never fabricate a success.
//  3. Only after the provider returns a provider order id do we start a
//     transaction: debit the wallet, insert the order (link holds
//     provider_order_id), record the ledger — atomically, exactly once.
//     A duplicate provider order id is refused by the unique index.
// ---------------------------------------------------------------------------
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
  if (user.wallet_balance < final) throw new InsufficientBalanceError();

  // STEP 2 — provider first. No wallet/DB write happens on failure.
  const adapter = createAdapter(provider.adapter, provider);
  let routed;
  try {
    routed = await adapter.placeOrder({
      service: service.provider_service_id || String(service.id),
      link: String(link).trim(),
      quantity,
      extras,
    });
  } catch (e) {
    const msg = `Provider rejected the order: ${e.message}`;
    console.warn('[instasmm] order rejected by provider  ✓ no debit', `#${user.email}`);
    db.prepare('UPDATE providers SET last_error=?, last_success_at=NULL, updated_at=? WHERE id=?')
      .run(msg.slice(0, 300), Date.now(), provider.id);
    const err = new ProviderError(msg); err.cause = e; throw err;
  }

  const providerOrderId = routed?.id || null;
  if (!providerOrderId) {
    const err = new ProviderError('Provider did not return an order id — nothing ordered, nothing charged.');
    throw err;
  }
  const initialStatus = String(routed?.status || 'PENDING').toUpperCase();

  // Mark provider connectivity healthy.
  db.prepare('UPDATE providers SET last_success_at=?, last_error=NULL, updated_at=? WHERE id=?')
    .run(Date.now(), Date.now(), provider.id);

  const now = Date.now();
  const orderRef = newId('ORD-');
  let orderId;

  db.exec('BEGIN');
  try {
    const newBalance = user.wallet_balance - final;
    db.prepare('UPDATE users SET wallet_balance=?, total_spent_inr=? WHERE id=?')
      .run(newBalance, user.total_spent_inr + final, user.id);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'order', ?, ?, NULL, ?, ?)`
    ).run(user.id, -final, newBalance, JSON.stringify({ service: service.name }), now);

    const ins = db.prepare(
      `INSERT INTO orders
         (order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity,
          price_inr, base_cost_inr, coupon_id, discount_inr, status,
          start_count, remains, provider_charge, provider_currency, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`
    );
    const res = ins.run(
      orderRef, user.id, service.id, provider.id, providerOrderId, String(link).trim(), quantity,
      pricing.price, pricing.base, coupon?.id ?? null, pricing.discount,
      initialStatus, quantity,
      Number.isFinite(routed.charge) ? routed.charge : null,
      routed.currency || provider.currency || null,
      now, now
    );
    orderId = Number(res.lastInsertRowid);

    if (coupon) {
      db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, order_id, discount_inr, created_at) VALUES (?,?,?,?,?)')
        .run(coupon.id, user.id, orderId, pricing.discount, now);
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id=?').run(coupon.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // Duplicate provider order id → the same upstream order was already placed.
    if (/idx_orders_prov_order|UNIQUE/.test(String(e.message))) {
      const err = new ProviderError('This upstream order id was already accepted — duplicate order refused.');
      throw err;
    }
    throw e;
  }

  try {
    notify(user.id, 'order', 'Order Created',
      `#${orderRef} — ${service.name} × ${quantity}. Accepted by provider, ${initialStatus.replace('_', ' ')}.`);
  } catch { /* never block on a notification */ }

  user.wallet_balance = user.wallet_balance - final;
  const placed = orderWithService(db, orderId);
  return placed;
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
  const active = db.prepare(
    `SELECT o.*, s.provider_rate FROM orders o
     JOIN services s ON s.id = o.service_id
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

  const now = Date.now();
  const remains = Math.max(0, Number(o.remains) || 0);
  const refundInr = supportsCancel && remains > 0
    ? Math.round((o.price_inr * remains) / Math.max(1, o.quantity))
    : 0;

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE orders SET status='CANCELED', remains=?, updated_at=? WHERE id=?")
      .run(remains, now, o.id);
    if (refundInr > 0) {
      const user = db.prepare('SELECT wallet_balance, total_spent_inr FROM users WHERE id=?').get(o.user_id);
      const newBalance = user.wallet_balance + refundInr;
      db.prepare('UPDATE users SET wallet_balance=? WHERE id=?').run(newBalance, o.user_id);
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
  if (service?.refill !== 1) { const e = new Error('This service does not support refill.'); e.code = 'NO_REFILL'; throw e; }

  let upstream;
  try {
    upstream = await createAdapter(provider.adapter, provider).refill(o.provider_order_id || o.order_ref);
  } catch (e) {
    db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?').run(String(e.message).slice(0, 300), Date.now(), provider.id);
    const err = new ProviderError(`Provider refused the refill: ${e.message}`); throw err;
  }

  const now = Date.now();
  const upStatus = String(upstream?.status || 'IN_PROGRESS').toUpperCase();
  db.prepare("UPDATE orders SET status=?, start_count=0, remains=quantity, updated_at=? WHERE id=?")
    .run(normalizeStatus(upStatus), now, o.id);

  logSecurity(admin?.id, admin?.email, 'refill_order', 'admin');
  notify(o.user_id, 'order', 'Order Refilled', `#${o.order_ref} has been refilled.`);
  return { ok: true, status: normalizeStatus(upStatus) };
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
            c.name AS category_name
     FROM orders o
     JOIN services s ON s.id = o.service_id
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
            s.name AS service_name, s.speed_hint, c.name AS category_name
     FROM orders o
     JOIN services s ON s.id = o.service_id
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 200`
  ).all(userId);
}