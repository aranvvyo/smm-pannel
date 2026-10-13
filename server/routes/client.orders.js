import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  placeOrder, quoteOrder, userOrders, orderWithService,
  InsufficientBalanceError, ProviderError, DuplicateOrderError, OrderVerifyingError,
} from '../lib/orderRouter.js';
import { ah, sendErr } from './_helpers.js';
import { requestRefill, RefillError } from '../lib/orderRefill.js';

// POST /api/quote — preview cost + coupon effect (server-side math only).
// Mounted separately at /api/quote.
export const quoteRouter = Router();
quoteRouter.post('/quote', requireAuth, (req, res) => {
  const { serviceId, quantity, coupon_code } = req.body || {};
  try {
    const result = quoteOrder({ serviceId, quantity, couponCode: coupon_code, noProfit: req.user.no_profit === 1 });
    return res.json(result);
  } catch (e) {
    return sendErr(res, 400, e.message, e.code);
  }
});

const r = Router();

// Reversible order kill-switch (incident response): ORDERS_ENABLED=0
// pauses NEW customer orders with a clean 503 while the rest of the
// site (deposits, wallet, history, admin) keeps working. Toggled by
// environment + restart — no database change, no site-wide outage.
// Read at request time so a restart picks the value up immediately.
r.post('/', requireAuth, (req, res, next) => {
  if (process.env.ORDERS_ENABLED === '0') {
    return sendErr(res, 503, 'New orders are temporarily paused. Please try again shortly.', 'ORDERS_PAUSED');
  }
  return next();
}, ah(async (req, res) => {
  const { serviceId, link, quantity, coupon_code, comments, runs, interval } = req.body || {};
  try {
    const order = await placeOrder({
      user: req.user,
      serviceId,
      link,
      quantity,
      couponCode: coupon_code || null,
      extras: { comments, runs, interval },
    });
    return res.status(201).json({ order });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) {
      return sendErr(res, 402, 'Insufficient balance. Deposit funds to continue.', 'INSUFFICIENT_BALANCE');
    }
    if (e instanceof ProviderError) {
      // Task 8 (client privacy): the provider's own error text lives INSIDE the
      // admin audit trail ({last_error}) — it must never be echoed to a client
      // (it can name the supplier). The reservation has been refunded, so this is
      // a truthful outcome.
      return sendErr(res, 502, 'The supplier did not accept this order, so your balance was not charged. Please try again in a moment or contact support.', 'PROVIDER_ERROR');
    }
    if (e instanceof OrderVerifyingError) {
      // Supplier outcome unknown. Never claim it started, and never refund here.
      // 202 = received, verification pending. The customer must not resubmit.
      return res.status(202).json({
        error: e.message,
        code: 'VERIFYING',
        order_ref: e.orderRef,
        status: 'AMBIGUOUS',
      });
    }
    if (e instanceof DuplicateOrderError) {
      return sendErr(res, 409, e.message, 'DUPLICATE_ORDER');
    }
    if (e.code) return sendErr(res, 400, e.message, e.code);
    // Unknown failure: never echo an internal error message to the client.
    console.error('[instasmm] order placement failed:', e && e.message);
    return sendErr(res, 500, 'Something went wrong while placing this order. Check your order history before trying again.', 'ORDER_FAILED');
  }
}));

// GET /api/orders — user's order history.
r.get('/', requireAuth, (req, res) => {
  return res.json({ orders: userOrders(getDb(), req.user.id) });
});

// GET /api/orders/:id
r.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT id, user_id FROM orders WHERE id=?').get(req.params.id);
  if (!order || order.user_id !== req.user.id) return sendErr(res, 404, 'Order not found.');
  return res.json({ order: orderWithService(db, order.id) });
});

// POST /api/orders/:id/refill — customer refill. Ownership, eligibility, one active
// refill per order and the supplier's reply are all checked on the server. The
// supplier id is never returned to the client.
r.post('/:id/refill', requireAuth, ah(async (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!order || order.user_id !== req.user.id) return sendErr(res, 404, 'Order not found.');
  const service = order.service_id
    ? db.prepare('SELECT id, refill FROM services WHERE id=?').get(order.service_id) : null;
  const provider = order.provider_id
    ? db.prepare('SELECT id, adapter, api_url, api_key, active FROM providers WHERE id=?').get(order.provider_id) : null;
  try {
    const out = await requestRefill({ db, order, service, provider, actor: 'customer', userId: req.user.id });
    return res.status(202).json({ ok: true, refill_status: out.status, order: orderWithService(db, order.id) });
  } catch (e) {
    if (e instanceof RefillError) return sendErr(res, e.http, e.message, e.code);
    throw e;
  }
}));

export default r;