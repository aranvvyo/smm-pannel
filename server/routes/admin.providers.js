import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { createAdapter, maskedProvider } from '../lib/provider.js';
import '../lib/providers/demo.js';
import '../lib/providers/smmpost.js';
import { syncProviderServices } from '../lib/providerSync.js';
import { logSecurity } from '../middleware/auth.js';
import { ah, sendErr } from './_helpers.js';
import { getSetting } from '../db.js';

const r = Router();
r.use(requireAdmin);

// The demo adapter exists ONLY in SMM_TEST servers — a normal production admin
// can only ever create a real smmpost provider.
const TEST = process.env.SMM_TEST === '1';
const AVAILABLE_ADAPTERS = TEST ? ['smmpost', 'demo'] : ['smmpost'];

// GET /api/admin/providers — masked: api_key/api_url never leave the server.
// Connection status, balance + currency, markup, last sync/success/error are
// exposed here (admin-only namespace; client RPCs never see them).
r.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM providers ORDER BY id').all();
  return res.json({
    providers: rows.map(maskedProvider),
    adapters: AVAILABLE_ADAPTERS.map((a) => ({ id: a, available: true })),
  });
});

// POST /api/admin/providers — full form. api_key is stored server-side, never
// returned. Markup is per-provider (fallback applied at service sync).
r.post('/', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return sendErr(res, 400, 'Provider name is required.');
  if (!body.api_key) return sendErr(res, 400, 'API key is required (server-side only).');
  const adapter = AVAILABLE_ADAPTERS.includes(body.adapter) ? body.adapter : 'smmpost';
  const markupType = body.markup_type === 'fixed' ? 'fixed' : 'percent';
  const markupValue = Number(body.markup_value ?? (markupType === 'percent' ? 25 : 0));
  if (!Number.isFinite(markupValue) || markupValue < 0) return sendErr(res, 400, 'Invalid markup value.');
  // Active unless explicitly paused (an explicitly-active provider must
  // never be stored as paused — orders only route to active=1 rows).
  const active = body.active === 0 ? 0 : 1;
  const now = Date.now();
  const info = getDb().prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, currency, markup_type, markup_value, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    name, adapter, body.api_url || null, String(body.api_key),
    active,
    String(body.currency || 'USD'), markupType, markupValue, now, now
  );
  logSecurity(req.user.id, req.user.email, 'add_provider', 'admin');
  return res.status(201).json(maskedProvider(getDb().prepare('SELECT * FROM providers WHERE id=?').get(Number(info.lastInsertRowid))));
});

// PATCH /api/admin/providers/:id — edit name/endpoint/markup/currency/active.
// api_key/api_url cannot be read back; send blank to keep the stored
// value (the admin form opens with empty secret/endpoint fields, so a
// save without re-entering them must NEVER wipe the stored config).
r.patch('/:id', (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!p) return sendErr(res, 404, 'Provider not found.');
  const body = req.body || {};
  const sentKey = String(body.api_key ?? '').trim();
  const newKey = sentKey ? sentKey : p.api_key;
  const sentUrl = body.api_url === undefined || body.api_url === null
    ? null
    : String(body.api_url).trim();
  const newUrl = sentUrl ? sentUrl : p.api_url;
  const markupType = body.markup_type ? (body.markup_type === 'fixed' ? 'fixed' : 'percent') : p.markup_type;
  const markupValue = body.markup_value !== undefined ? Number(body.markup_value) : p.markup_value;
  if (!Number.isFinite(markupValue) || markupValue < 0) return sendErr(res, 400, 'Invalid markup value.');
  db.prepare(
    `UPDATE providers SET name=?, adapter=?, api_url=?, api_key=?, active=?, currency=?, markup_type=?, markup_value=?, updated_at=? WHERE id=?`
  ).run(
    String(body.name ?? p.name),
    AVAILABLE_ADAPTERS.includes(body.adapter) ? body.adapter : p.adapter,
    newUrl,
    newKey,
    body.active === undefined ? p.active : Number(body.active),
    body.currency ? String(body.currency) : p.currency,
    markupType, markupValue, Date.now(), p.id
  );
  logSecurity(req.user.id, req.user.email, 'edit_provider', 'admin');
  return res.json(maskedProvider(db.prepare('SELECT * FROM providers WHERE id=?').get(p.id)));
});

// DELETE /api/admin/providers/:id — removes provider + services, but only
// while no order references it (orders keep immutable history).
r.delete('/:id', (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!p) return sendErr(res, 404, 'Provider not found.');
  const orderCount = db.prepare('SELECT COUNT(*) c FROM orders WHERE provider_id=?').get(p.id).c;
  if (orderCount > 0) {
    return sendErr(res, 409,
      `${orderCount} order(s) reference this provider — orders keep an immutable history. ` +
      'Pause the provider instead (Edit → Active = No), or delete it once those orders are gone.');
  }
  db.prepare('DELETE FROM providers WHERE id=?').run(p.id);
  logSecurity(req.user.id, req.user.email, 'delete_provider', 'admin');
  return res.json({ ok: true });
});

// POST /api/admin/providers/:id/test — Test Connection: hits the real
// balance action, records last_success_at / last_error, returns balance+currency.
r.post('/:id/test', ah(async (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!p) return sendErr(res, 404, 'Provider not found.');
  try {
    const adapter = createAdapter(p.adapter, p);
    const out = await adapter.balance();
    const balance = Number(out?.balance ?? out) || 0;
    const currency = String(out?.currency || p.currency || 'USD');
    db.prepare('UPDATE providers SET balance=?, currency=?, last_success_at=?, last_error=NULL, updated_at=? WHERE id=?')
      .run(balance, currency, Date.now(), Date.now(), p.id);
    return res.json({ ok: true, balance, currency });
  } catch (e) {
    db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
      .run(String(e.message).slice(0, 300), Date.now(), p.id);
    return sendErr(res, 502, `Provider test failed: ${e.message}`);
  }
}));

// POST /api/admin/providers/:id/sync-services — pull services from the real
// provider and upsert into the catalog. New services carry the provider markup
// (falling back to global settings); existing services KEEP their admin-set
// per-service markup so an admin override is never clobbered by a re-sync.
r.post('/:id/sync-services', ah(async (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id);
  if (!p) return sendErr(res, 404, 'Provider not found.');
  // The adapter factory itself can fail (missing endpoint/key) — surface
  // that as a truthful 502, never an unhandled 500.
  let adapter;
  try {
    adapter = createAdapter(p.adapter, p);
  } catch (e) {
    db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
      .run(String('Sync failed: ' + e.message).slice(0, 300), Date.now(), p.id);
    return sendErr(res, 502, `Sync failed: ${e.message}`);
  }
  let list;
  try {
    list = await adapter.listServices();
  } catch (e) {
    db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
      .run(String('Sync failed: ' + e.message).slice(0, 300), Date.now(), p.id);
    return sendErr(res, 502, `Sync failed: ${e.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    return sendErr(res, 400, 'Provider returned no services — nothing to sync.');
  }
  const globalType = getSetting('global_markup_type') || 'percent';
  const globalValue = Number(getSetting('global_markup_value') ?? 25);
  const out = syncProviderServices(db, { provider: p, list, globalMarkup: { type: globalType, value: globalValue } });
  db.prepare('UPDATE providers SET last_sync_at=?, last_success_at=?, last_error=NULL, updated_at=? WHERE id=?')
    .run(Date.now(), Date.now(), Date.now(), p.id);
  logSecurity(req.user.id, req.user.email, 'sync_services', 'admin');
  return res.json({
    pulled: list.length, added: out.added, updated: out.updated, skipped: out.skipped || 0,
    message: `Synced ${list.length} services from ${p.name}.`,
  });
}));

export default r;