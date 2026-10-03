import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { applyMarkup } from '../lib/money.js';
import { logSecurity } from '../middleware/auth.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

function svcCell(s) {
  // Admin panel legitimately needs provider_rate/markup (it owns the panel).
  return {
    id: s.id, category_id: s.category_id, provider_id: s.provider_id,
    provider_service_id: s.provider_service_id, name: s.name, description: s.description,
    speed_hint: s.speed_hint, type: s.type, min: s.min, max: s.max, quality: s.quality,
    provider_rate: s.provider_rate, admin_rate: s.admin_rate,
    markup_type: s.markup_type, markup_value: s.markup_value,
    refill: Number(s.refill), cancel: Number(s.cancel),
    status: s.status, category_name: s.category_name, provider_name: s.provider_name,
  };
}

// GET /api/admin/services — full catalog (admin sees costs, client never does).
r.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.*, c.name AS category_name, p.name AS provider_name
     FROM services s
     JOIN categories c ON c.id = s.category_id
     JOIN providers p ON p.id = s.provider_id
     ORDER BY c.sort, s.name`
  ).all();
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort').all();
  return res.json({ services: rows.map(svcCell), categories: cats });
});

// POST /api/admin/services — create service and auto-computes admin_rate.
r.post('/', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const providerId = Number(body.provider_id);
  const categoryId = Number(body.category_id);
  const providerRate = Number(body.provider_rate);
  if (!name || !providerId || !categoryId || !Number.isFinite(providerRate)) {
    return sendErr(res, 400, 'name, category_id, provider_id and provider_rate are required.');
  }
  const db = getDb();
  const p = db.prepare('SELECT id FROM providers WHERE id=?').get(providerId);
  const c = db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId);
  if (!p || !c) return sendErr(res, 400, 'Invalid provider or category.');
  const markupType = body.markup_type === 'fixed' ? 'fixed' : 'percent';
  const markupValue = Number(body.markup_value || (markupType === 'percent' ? 25 : 0));
  const adminRate = applyMarkup(providerRate, markupType, markupValue);
  const quality = String(body.quality || '').trim() || null;
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, description, speed_hint,
       type, min, max, provider_rate, admin_rate, quality, markup_type, markup_value, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    categoryId, providerId, body.provider_service_id || null, name, body.description || null,
    body.speed_hint || null, body.type || 'Default', Number(body.min || 1), Number(body.max || 999999),
    providerRate, adminRate, quality, markupType, markupValue,
    Number(body.refill) ? 1 : 0, Number(body.cancel) ? 1 : 0, body.status === 0 ? 0 : 1, now
  );
  return res.status(201).json({ id: Number(info.lastInsertRowid), admin_rate: adminRate });
});

// PATCH /api/admin/services/:id — edit pricing/markup. admin_rate recomputed if
// markup or provider_rate changes.
r.patch('/:id', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!s) return sendErr(res, 404, 'Service not found.');
  const body = req.body || {};

  const providerRate = Number(body.provider_rate ?? s.provider_rate);
  const markupType = body.markup_type || s.markup_type;
  const markupValue = Number(body.markup_value ?? s.markup_value);
  const overrideRate = Number.isFinite(Number(body.admin_rate)) ? Number(body.admin_rate) : null;
  const adminRate = overrideRate != null ? overrideRate : applyMarkup(providerRate, markupType, markupValue);
  const quality = body.quality === undefined ? s.quality : (String(body.quality).trim() || null);

  db.prepare(
    `UPDATE services SET name=?, description=?, speed_hint=?, type=?, min=?, max=?,
      provider_rate=?, admin_rate=?, quality=?, markup_type=?, markup_value=?, refill=?, cancel=?, status=?,
      category_id=?, provider_id=?, provider_service_id=? WHERE id=?`
  ).run(
    String(body.name ?? s.name), body.description ?? s.description, body.speed_hint ?? s.speed_hint,
    body.type ?? s.type, Number(body.min ?? s.min), Number(body.max ?? s.max),
    providerRate, adminRate, quality, markupType, markupValue,
    body.refill === undefined ? s.refill : (Number(body.refill) ? 1 : 0),
    body.cancel === undefined ? s.cancel : (Number(body.cancel) ? 1 : 0),
    body.status === undefined ? s.status : Number(body.status),
    Number(body.category_id ?? s.category_id), Number(body.provider_id ?? s.provider_id),
    body.provider_service_id ?? s.provider_service_id, s.id
  );
  logSecurity(req.user.id, req.user.email, 'edit_service', 'admin');
  const updated = db.prepare('SELECT * FROM services WHERE id=?').get(s.id);
  return res.json({ service: svcCell(updated) });
});

// POST /api/admin/markup/global — set global markup across ALL services
// { markup_type, markup_value }
r.post('/markup/global', (req, res) => {
  const body = req.body || {};
  const markupType = body.markup_type === 'fixed' ? 'fixed' : 'percent';
  const markupValue = Number(body.markup_value ?? 25);
  const db = getDb();
  const all = db.prepare('SELECT * FROM services').all();
  const upd = db.prepare('UPDATE services SET markup_type=?, markup_value=?, admin_rate=? WHERE id=?');
  let n = 0;
  for (const s of all) {
    upd.run(markupType, markupValue, applyMarkup(s.provider_rate, markupType, markupValue), s.id);
    n++;
  }
  logSecurity(req.user.id, req.user.email, 'global_markup', 'admin');
  return res.json({ updated: n });
});

// POST /api/admin/services/:id/sync — re-pull from provider (replaces catalog).
r.post('/:id/sync', ah(async (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!s) return sendErr(res, 404, 'Service not found.');
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(s.provider_id);
  if (!p) return sendErr(res, 404, 'Provider not found.');
  const { createAdapter } = await import('../lib/provider.js');
  try {
    const adapter = createAdapter(p.adapter, p);
    const list = await adapter.listServices();
    return res.json({ services: list, count: list.length });
  } catch (e) {
    return sendErr(res, 502, `Provider sync failed: ${e.message}`);
  }
}));

export default r;