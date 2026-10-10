// ---------------------------------------------------------------------------
// Independent maintenance switches for INR and crypto deposits.
//
// Storage: the existing `settings` table (key/value). Defaults are seeded with
// INSERT OR IGNORE (config.defaultSettings), so a restart never overwrites a
// stored value.
//
// What "maintenance" blocks: CREATING a new deposit request, INR claim
// ("I have paid") and new crypto invoices. It never blocks: reading history,
// the INR status check for an existing deposit, crypto webhooks/reconciliation
// of existing invoices, admin review, or admin verification. It never changes a
// deposit, a transaction hash, or a balance.
//
// Concurrency: every change is a compare-and-set on a per-method version. A
// save based on a stale view is refused, so it cannot overwrite a newer one.
// ---------------------------------------------------------------------------
import { getDb } from '../db.js';

export const DEPOSIT_MAINTENANCE_CODE = 'DEPOSIT_MAINTENANCE';
export const METHODS = ['inr', 'crypto'];
export const MAX_MESSAGE_LENGTH = 200;

const DEFAULT_MESSAGE = {
  inr: 'INR deposits are temporarily unavailable while payment verification is being prepared.',
  crypto: 'Crypto deposits are temporarily paused. Please try again later.',
};

const keyOf = (method, field) => `maint_${method}_${field}`;

function assertMethod(method) {
  if (!METHODS.includes(method)) {
    const e = new Error('Unknown deposit method.'); e.code = 'BAD_METHOD'; throw e;
  }
}

// Plain text only. Control characters are removed, whitespace collapsed, and
// the result length-limited. The UI renders it as text, never as HTML.
export function sanitizeMessage(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function getMaintenance(method) {
  assertMethod(method);
  const rows = getDb().prepare(
    `SELECT key, value FROM settings WHERE key IN (?,?,?,?,?)`
  ).all(keyOf(method, 'enabled'), keyOf(method, 'message'), keyOf(method, 'version'),
        keyOf(method, 'updated_at'), keyOf(method, 'updated_by'));
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const message = sanitizeMessage(v[keyOf(method, 'message')]);
  return {
    method,
    enabled: v[keyOf(method, 'enabled')] === '1',
    message: message || DEFAULT_MESSAGE[method],
    version: Number(v[keyOf(method, 'version')] || 0),
    updated_at: v[keyOf(method, 'updated_at')] ? Number(v[keyOf(method, 'updated_at')]) : null,
    updated_by: v[keyOf(method, 'updated_by')] || null,
  };
}

export function getAllMaintenance() {
  return Object.fromEntries(METHODS.map((m) => [m, getMaintenance(m)]));
}

// Throws DEPOSIT_MAINTENANCE when new deposits for this method are paused.
export function assertDepositsOpen(method) {
  const state = getMaintenance(method);
  if (state.enabled) {
    const e = new Error(state.message);
    e.code = DEPOSIT_MAINTENANCE_CODE;
    e.maintenance = { method, message: state.message };
    throw e;
  }
}

// Compare-and-set update. Returns { ok:false, reason:'stale', current } when the
// caller's expectedVersion is not the stored version.
export function setMaintenance({ method, enabled, message, actor, expectedVersion, now = Date.now() }) {
  assertMethod(method);
  if (typeof enabled !== 'boolean') {
    const e = new Error('enabled must be true or false.'); e.code = 'BAD_INPUT'; throw e;
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    const e = new Error('expected_version must be a non-negative integer.'); e.code = 'BAD_INPUT'; throw e;
  }
  const db = getDb();
  const next = expectedVersion + 1;
  db.exec('BEGIN');
  try {
    const cas = db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
      .run(String(next), keyOf(method, 'version'), String(expectedVersion));
    if (cas.changes !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'stale', current: getMaintenance(method) };
    }
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    put.run(keyOf(method, 'enabled'), enabled ? '1' : '0');
    put.run(keyOf(method, 'message'), sanitizeMessage(message));
    put.run(keyOf(method, 'updated_at'), String(now));
    put.run(keyOf(method, 'updated_by'), String(actor || '').slice(0, 200));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, state: getMaintenance(method) };
}
