import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { fmtIST } from '../lib/ist.js';
import { sendErr, ah } from './_helpers.js';
import { resolveRefillReview, RefillError } from '../lib/orderRefill.js';
import { cancelOrder as realCancel, refillOrder as realRefill, reconcileOrder, LifecycleError } from '../lib/orderRouter.js';

const r = Router();
r.use(requireAdmin);

// Statuses that must not be retried or re-placed until an admin reconciles them.
const DO_NOT_RETRY = new Set(['SUBMITTING', 'AMBIGUOUS']);
const RECONCILE_HELP = {
  SUBMITTING: 'Supplier outcome not recorded yet. Wait for the stale-order sweep or reconcile after checking the supplier.',
  AMBIGUOUS: 'The supplier may have accepted this order. Check the supplier first: accept with its order ID, or reject to refund once.',
  REJECTED: 'The supplier refused this order and the reservation was refunded once.',
};

// GET /api/admin/orders — full order list with filters (status, q).
// Exposes refill/cancel capability so the UI only shows buttons the REAL
// provider stack supports. Admin-only: this is where supplier identifiers appear.
r.get('/', (req, res) => {
  const db = getDb();
  const status = String(req.query.status || '').toUpperCase();
  const q = String(req.query.q || '').trim();
  let sql = `SELECT o.id, o.order_ref, o.user_id, o.link, o.quantity, o.price_inr, o.base_cost_inr,
                    o.status, o.start_count, o.remains, o.provider_charge, o.provider_currency, o.created_at,
                    o.updated_at, o.provider_id, o.provider_order_id, p.name AS provider_name,
                    u.email, s.name AS service_name, s.refill, s.cancel
             FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN services s ON s.id=o.service_id
             LEFT JOIN providers p ON p.id=o.provider_id`;
  const where = [];
  const args = [];
  if (status && status !== 'ALL') { where.push('o.status=?'); args.push(status); }
  if (q) { where.push('(u.email LIKE ? OR o.order_ref LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY o.created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...args);
  return res.json({
    orders: rows.map((o) => ({
      ...o,
      created_at_ist: fmtIST(o.created_at),
      acceptance: o.provider_order_id ? 'supplier_id_recorded' : (o.status === 'REJECTED' ? 'rejected' : 'unconfirmed'),
      do_not_retry: DO_NOT_RETRY.has(o.status),
      reconcile_help: RECONCILE_HELP[o.status] || null,
    })),
  });
});

// POST /api/admin/orders/:id/reconcile — resolves an AMBIGUOUS order with evidence.
//   { action: 'accept', provider_order_id } — the supplier confirmed the order.
//   { action: 'reject' }                    — the supplier confirmed it did NOT accept.
// Never places an order. Reject refunds the reservation exactly once.
r.post('/:id/reconcile', (req, res) => {
  try {
    const out = reconcileOrder({
      db: getDb(),
      admin: req.user,
      orderId: Number(req.params.id),
      action: String(req.body?.action || ''),
      providerOrderId: req.body?.provider_order_id,
    });
    return res.json(out);
  } catch (e) {
    const map = {
      NOT_FOUND: 404, NOT_AMBIGUOUS: 409, DUPLICATE_PROVIDER_ID: 409,
      BAD_PROVIDER_ID: 400, BAD_ACTION: 400, FORBIDDEN: 403, NO_DEBIT: 500,
    };
    if (e instanceof LifecycleError || map[e.code]) return sendErr(res, map[e.code] || 400, e.message, e.code);
    return sendErr(res, 500, 'Reconciliation failed. Nothing was changed.', 'RECONCILE_FAILED');
  }
});

// POST /api/admin/orders/:id/cancel — REAL cancel: calls the orderRouter which
// (a) only acts for services whose provider supports cancel, and (b) talks to
// the upstream provider. Failure surface a 502 with the real error — never a
// fake "canceled".
r.post('/:id/cancel', ah(async (req, res) => {
  try {
    const out = await realCancel({ admin: req.user, orderId: Number(req.params.id) });
    return res.json(out);
  } catch (e) {
    if (e.code === '404') return sendErr(res, 404, e.message);
    if (e.code === 'BAD_STATUS') return sendErr(res, 400, e.message);
    if (e.code === 'PROVIDER_ERROR') return sendErr(res, 502, e.message);
    return sendErr(res, 502, `Cancel failed: ${e.message}`);
  }
}));

// POST /api/admin/orders/:id/refill-review — admin decision on an AMBIGUOUS or abandoned
// refill, after checking the supplier by hand. Never calls the supplier.
r.post('/:id/refill-review', ah(async (req, res) => {
  const b = req.body || {};
  try {
    const out = resolveRefillReview({
      db: getDb(), orderId: Number(req.params.id), adminId: req.user?.id,
      decision: b.decision, refillId: b.refill_id, note: b.note,
    });
    return res.json(out);
  } catch (e) {
    if (e instanceof RefillError) return sendErr(res, e.http, e.message, e.code);
    throw e;
  }
}));

// POST /api/admin/orders/:id/refill — REAL refill, gated on upstream support.
r.post('/:id/refill', ah(async (req, res) => {
  try {
    const out = await realRefill({ admin: req.user, orderId: Number(req.params.id) });
    return res.json(out);
  } catch (e) {
    if (e.code === '404') return sendErr(res, 404, e.message);
    if (e.code === 'NO_REFILL') return sendErr(res, 400, e.message);
    if (e.http) return sendErr(res, e.http, e.message);
    if (e.code === 'PROVIDER_ERROR') return sendErr(res, 502, e.message);
    return sendErr(res, 502, `Refill failed: ${e.message}`);
  }
}));

export default r;