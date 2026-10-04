import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { fmtIST } from '../lib/ist.js';
import { sendErr, ah } from './_helpers.js';
import { cancelOrder as realCancel, refillOrder as realRefill } from '../lib/orderRouter.js';

const r = Router();
r.use(requireAdmin);

// GET /api/admin/orders — full order list with filters (status, q).
// Exposes refill/cancel capability so the UI only shows buttons the REAL
// provider stack supports.
r.get('/', (req, res) => {
  const db = getDb();
  const status = String(req.query.status || '').toUpperCase();
  const q = String(req.query.q || '').trim();
  let sql = `SELECT o.id, o.order_ref, o.user_id, o.link, o.quantity, o.price_inr, o.base_cost_inr,
                    o.status, o.start_count, o.remains, o.provider_charge, o.provider_currency, o.created_at,
                    u.email, s.name AS service_name, s.refill, s.cancel
             FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN services s ON s.id=o.service_id`;
  const where = [];
  const args = [];
  if (status && status !== 'ALL') { where.push('o.status=?'); args.push(status); }
  if (q) { where.push('(u.email LIKE ? OR o.order_ref LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY o.created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...args);
  return res.json({ orders: rows.map((o) => ({ ...o, created_at_ist: fmtIST(o.created_at) })) });
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

// POST /api/admin/orders/:id/refill — REAL refill, gated on upstream support.
r.post('/:id/refill', ah(async (req, res) => {
  try {
    const out = await realRefill({ admin: req.user, orderId: Number(req.params.id) });
    return res.json(out);
  } catch (e) {
    if (e.code === '404') return sendErr(res, 404, e.message);
    if (e.code === 'NO_REFILL') return sendErr(res, 400, e.message);
    if (e.code === 'PROVIDER_ERROR') return sendErr(res, 502, e.message);
    return sendErr(res, 502, `Refill failed: ${e.message}`);
  }
}));

export default r;