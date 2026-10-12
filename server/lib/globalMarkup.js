// ---------------------------------------------------------------------------
// Global service markup. Pure validation plus one atomic apply.
//
// Root cause this fixes: the admin "Global markup" action rewrote every
// services row but never saved the global_markup_type / global_markup_value
// settings. Provider sync reads those settings for new and re-synced services,
// so they kept the old markup (25% by default), and the input was not
// validated, so a non-numeric value was stored as NaN.
//
// Now the settings and every service row change in ONE transaction, and input
// is validated before anything is written.
//
// Precedence (unchanged, now documented): a global apply sets the markup on
// every service, including services with an earlier individual markup. A
// later provider sync does not overwrite a service's stored admin_rate.
// ---------------------------------------------------------------------------
import { applyMarkup } from './money.js';

// Upper bounds stop typos from producing absurd prices. Percent: 0–1000%.
// Fixed: rupees per 1,000 units, 0–100000.
export const GLOBAL_MARKUP_LIMITS = Object.freeze({
  percent: { min: 0, max: 1000 },
  fixed: { min: 0, max: 100000 },
});

// Accepts a finite number or a plain decimal string. Rejects NaN, Infinity,
// negatives, empty strings, booleans, arrays and objects.
function parseMarkupNumber(raw) {
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+(\.\d{1,4})?$/.test(raw.trim())) n = Number(raw.trim());
  else return null;
  return Number.isFinite(n) ? n : null;
}

// Returns { ok: true, markup_type, markup_value } or { ok: false, message }.
export function validateGlobalMarkup(body = {}) {
  const type = body.markup_type;
  if (type !== 'percent' && type !== 'fixed') {
    return { ok: false, message: 'Markup type must be percent or fixed.' };
  }
  const value = parseMarkupNumber(body.markup_value);
  if (value === null) {
    return { ok: false, message: 'Enter a markup value as a plain number (for example 25).' };
  }
  const limits = GLOBAL_MARKUP_LIMITS[type];
  if (value < limits.min || value > limits.max) {
    return { ok: false, message: `${type === 'percent' ? 'Percent' : 'Fixed'} markup must be between ${limits.min} and ${limits.max}.` };
  }
  return { ok: true, markup_type: type, markup_value: value };
}

// Persists the global setting and reprices every service in one transaction.
// Rolls back completely on any error, so settings and services never disagree.
export function applyGlobalMarkup(db, { markup_type, markup_value }) {
  const check = validateGlobalMarkup({ markup_type, markup_value });
  if (!check.ok) throw new Error(check.message);
  const rows = db.prepare('SELECT id, provider_rate FROM services').all();
  const upsertSetting = db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  const updService = db.prepare('UPDATE services SET markup_type=?, markup_value=?, admin_rate=? WHERE id=?');
  db.exec('BEGIN');
  try {
    upsertSetting.run('global_markup_type', markup_type);
    upsertSetting.run('global_markup_value', String(markup_value));
    for (const s of rows) {
      const rate = applyMarkup(s.provider_rate, markup_type, markup_value);
      if (!Number.isFinite(rate) || rate < 0) throw new Error('markup produced an invalid rate');
      updService.run(markup_type, markup_value, rate, s.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { updated: rows.length, markup_type, markup_value };
}
