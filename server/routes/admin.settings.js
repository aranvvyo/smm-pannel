import { Router } from 'express';
import { getDb, setSetting } from '../db.js';
import { requireAdmin, logSecurity } from '../middleware/auth.js';
import { config } from '../config.js';
import { apironeCreds, apironeTestConnection } from '../lib/apirone.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

// Credentials in the settings table are write-only — they must never appear in
// any API response (admin panel included).
const SECRET_KEYS = ['apirone_account_id', 'apirone_transfer_key', 'apirone_webhook_token'];
const APIRONE_KEYS = ['apirone_account_id', 'apirone_transfer_key', 'apirone_webhook_token'];

// Masked Apirone section: the admin sees live/simulated readiness, the endpoint
// host (masked) and webhook readiness — NEVER the actual credentials.
function apironeSection() {
  const creds = apironeCreds();
  const configured = Boolean(creds.account_id && creds.transfer_key);
  const host = String(config.apirone.apiUrl || 'https://apirone.com').replace(/^https?:\/\//, '').split('/')[0];
  return {
    configured,
    mode: configured ? 'live' : 'simulated',
    api_url_masked: host ? `${host.slice(0, 6)}…` : null,
    account_masked: creds.account_id ? `${creds.account_id.slice(0, 3)}…${creds.account_id.slice(-2)}` : null,
    webhook_configured: Boolean(creds.webhook_token),
    simulator_active: !configured,
  };
}

// GET /api/admin/settings — all non-secret config rows + masked apirone status.
r.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT key,value FROM settings WHERE key NOT IN (?,?,?)')
    .all('apirone_account_id', 'apirone_transfer_key', 'apirone_webhook_token');
  return res.json({
    settings: Object.fromEntries(rows.map((x) => [x.key, x.value])),
    payment_mode: apironeSection().mode,
    apirone: apironeSection(),
  });
});

// POST /api/admin/settings — update one or more settings.
r.post('/', (req, res) => {
  const allowed = [
    'exchange_rate', 'deposit_timeout_hours', 'demo_auto_confirm', 'demo_confirm_seconds',
    'global_markup_type', 'global_markup_value',
    // Our own support channels (Task 9) — never supplier contact data.
    'support_email', 'support_whatsapp', 'support_telegram', 'support_phone',
    ...APIRONE_KEYS,
  ];
  const body = req.body || {};
  let changed = 0;
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    // Apirone credential fields: blank means "keep current value". A cleared
    // credential is not possible through this endpoint (deliberate — use the
    // DB directly if credentials must be revoked).
    if (APIRONE_KEYS.includes(key)) {
      const v = String(body[key]).trim();
      if (!v) continue;
      if (key === 'apirone_transfer_key' && v.length < 8) return sendErr(res, 400, 'Transfer key looks too short to be valid.');
      setSetting(key, v);
      changed++;
      continue;
    }
    if (key === 'exchange_rate') {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n <= 0) return sendErr(res, 400, 'Exchange rate must be > 0.');
      setSetting(key, Math.round(n));
    } else if (key === 'deposit_timeout_hours') {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 1) return sendErr(res, 400, 'Timeout must be ≥ 1 hour.');
      setSetting(key, n);
    } else if (key === 'global_markup_value') {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0) return sendErr(res, 400, 'Markup value must be ≥ 0.');
      setSetting(key, n);
    } else if (key === 'global_markup_type') {
      if (!['percent', 'fixed'].includes(body[key])) return sendErr(res, 400, 'Markup type must be percent or fixed.');
      setSetting(key, body[key]);
    } else {
      setSetting(key, body[key]);
    }
    changed++;
  }
  if (changed) logSecurity(req.user.id, req.user.email, 'update_settings', 'admin');
  return res.json({ ok: true, changed, apirone: apironeSection() });
});

// POST /api/admin/settings/apirone/test — verify stored credentials against the
// real Apirone API (auth-login exchange) WITHOUT creating any invoice.
r.post('/apirone/test', ah(async (req, res) => {
  const creds = apironeCreds();
  if (!creds.account_id || !creds.transfer_key) {
    return sendErr(res, 400, 'Enter an Account ID and Transfer Key first, then save, then test.');
  }
  const out = await apironeTestConnection();
  logSecurity(req.user.id, req.user.email, 'apirone_test', 'admin');
  return res.json(out);
}));

export default r;