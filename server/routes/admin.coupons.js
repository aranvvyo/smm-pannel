import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin, logSecurity } from '../middleware/auth.js';
import { fmtIST } from '../lib/ist.js';
import { sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

function cell(c) {
  return { ...c, starts_ist: c.starts_at ? fmtIST(c.starts_at) : null, expires_ist: c.expires_at ? fmtIST(c.expires_at) : null };
}

// GET /api/admin/coupons
r.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
  return res.json({ coupons: rows.map(cell) });
});

// POST /api/admin/coupons  {code,type,value,min_order,starts_at,expires_at,usage_limit}
r.post('/', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const type = b.type === 'fixed_inr' ? 'fixed_inr' : 'percent';
  const value = Number(b.value);
  if (!code) return sendErr(res, 400, 'Coupon code is required.');
  if (!Number.isFinite(value) || value <= 0) return sendErr(res, 400, 'Invalid discount value.');
  if (type === 'fixed_inr' && value < 0) return sendErr(res, 400, 'Invalid fixed amount.');
  if (type === 'percent' && (value < 0 || value > 100)) return sendErr(res, 400, 'Percent must be 0–100.');

  const db = getDb();
  if (db.prepare('SELECT id FROM coupons WHERE code=?').get(code)) {
    return sendErr(res, 409, 'Coupon code already exists.');
  }
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`
  ).run(
    code, type, value,
    Math.round(Number(b.min_order || 0) * 100),
    b.starts_at ? new Date(b.starts_at).getTime() : null,
    b.expires_at ? new Date(b.expires_at).getTime() : null,
    b.active === 0 ? 0 : 1,
    Number.isFinite(Number(b.usage_limit)) && Number(b.usage_limit) > 0 ? Number(b.usage_limit) : null,
    now
  );
  logSecurity(req.user.id, req.user.email, 'create_coupon', 'admin');
  const c = db.prepare('SELECT * FROM coupons WHERE id=?').get(Number(info.lastInsertRowid));
  return res.status(201).json({ coupon: cell(c) });
});

// PATCH /api/admin/coupons/:id
r.patch('/:id', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM coupons WHERE id=?').get(req.params.id);
  if (!c) return sendErr(res, 404, 'Coupon not found.');
  const b = req.body || {};
  db.prepare(
    `UPDATE coupons SET code=?, type=?, value=?, min_order_inr=?, starts_at=?, expires_at=?, active=?, usage_limit=? WHERE id=?`
  ).run(
    String(b.code || c.code).trim().toUpperCase(),
    b.type || c.type,
    Number.isFinite(Number(b.value)) ? Number(b.value) : c.value,
    Math.round(Number(b.min_order ?? (c.min_order_inr / 100)) * 100),
    b.starts_at ? new Date(b.starts_at).getTime() : c.starts_at,
    b.expires_at ? new Date(b.expires_at).getTime() : c.expires_at,
    b.active === undefined ? c.active : Number(b.active),
    b.usage_limit === undefined ? c.usage_limit : Number(b.usage_limit),
    c.id
  );
  logSecurity(req.user.id, req.user.email, 'edit_coupon', 'admin');
  const upd = db.prepare('SELECT * FROM coupons WHERE id=?').get(c.id);
  return res.json({ coupon: cell(upd) });
});

// DELETE /api/admin/coupons/:id
r.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM coupons WHERE id=?').run(req.params.id);
  return res.json({ ok: true });
});

export default r;