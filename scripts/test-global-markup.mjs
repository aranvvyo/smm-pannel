// ---------------------------------------------------------------------------
// Global markup regression tests. Temporary SQLite file only; no network, no
// production data.
//   run: node scripts/test-global-markup.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `global-markup-test-${process.pid}.db`);
process.env.DB_FILE = DB_FILE;
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const gm = await import(path.join(ROOT, 'server', 'lib', 'globalMarkup.js'));
const { applyMarkup } = await import(path.join(ROOT, 'server', 'lib', 'money.js'));
const db = dbm.getDb();
if (db.isPg) throw new Error('test-global-markup must run on the temporary SQLite file');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}

// ---- fixtures ------------------------------------------------------------
db.prepare("INSERT INTO categories (name, slug) VALUES ('Test', 'test-markup')").run();
const cat = db.prepare("SELECT id FROM categories WHERE name='Test'").get().id;
db.prepare("INSERT INTO providers (name, adapter, api_url, api_key, active, currency, markup_type, markup_value, created_at, updated_at) VALUES ('P','demo',NULL,NULL,1,'USD','percent',25,0,0)").run();
const prov = db.prepare("SELECT id FROM providers WHERE name='P'").get().id;
const addService = (name, rate, adminRate) => db.prepare(
  `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate, markup_type, markup_value, created_at)
   VALUES (?,?,?,?,?,?,'percent',25,0)`
).run(cat, prov, name, name, rate, adminRate).lastInsertRowid;
const s1 = addService('svc-a', 10, 12.5);
const s2 = addService('svc-b', 4, 5);
const setting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const snapshot = () => JSON.stringify({
  type: setting('global_markup_type'),
  value: setting('global_markup_value'),
  services: db.prepare('SELECT id, markup_type, markup_value, admin_rate FROM services ORDER BY id').all(),
});

console.log('Global markup tests (temporary SQLite)');

t('non-numeric, non-finite, negative, empty and wrong-type values are rejected', () => {
  const bad = [
    { markup_type: 'percent', markup_value: 'abc' },
    { markup_type: 'percent', markup_value: NaN },
    { markup_type: 'percent', markup_value: Infinity },
    { markup_type: 'percent', markup_value: -1 },
    { markup_type: 'percent', markup_value: '' },
    { markup_type: 'percent', markup_value: '1e3' },
    { markup_type: 'percent', markup_value: true },
    { markup_type: 'percent', markup_value: [25] },
    { markup_type: 'percent', markup_value: undefined },
    { markup_type: 'percent', markup_value: '25%' },
    { markup_type: 'percent', markup_value: 1001 },
    { markup_type: 'fixed', markup_value: 100001 },
    { markup_type: 'multiply', markup_value: 25 },
    {},
  ];
  for (const body of bad) {
    const r = gm.validateGlobalMarkup(body);
    assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(body)}`);
    assert.ok(typeof r.message === 'string' && !r.message.includes('NaN'));
  }
});

t('a rejected value changes nothing: settings and every service are untouched', () => {
  const before = snapshot();
  assert.throws(() => gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 'abc' }), /plain number/);
  assert.throws(() => gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: -5 }), /between/);
  assert.strictEqual(snapshot(), before);
});

t('valid apply reprices every service with the shared math and persists the settings', () => {
  const out = gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 30 });
  assert.strictEqual(out.updated, 2);
  const a = db.prepare('SELECT admin_rate, markup_value FROM services WHERE id=?').get(s1);
  const b = db.prepare('SELECT admin_rate, markup_value FROM services WHERE id=?').get(s2);
  assert.strictEqual(a.admin_rate, applyMarkup(10, 'percent', 30));   // 13
  assert.strictEqual(b.admin_rate, applyMarkup(4, 'percent', 30));    // 5.2
  assert.strictEqual(a.markup_value, 30);
  assert.strictEqual(setting('global_markup_type'), 'percent');
  assert.strictEqual(setting('global_markup_value'), '30');
});

t('the value provider sync reads (settings) now matches the applied markup, so sync cannot revert it', () => {
  // providerAutoSync reads: getSetting('global_markup_value') ?? 25
  const synced = Number(setting('global_markup_value') ?? 25);
  assert.strictEqual(synced, 30);
  assert.notStrictEqual(synced, 25);
});

t('fixed markup is applied as rupees per 1,000 on top of the provider rate', () => {
  gm.applyGlobalMarkup(db, { markup_type: 'fixed', markup_value: 2.5 });
  const a = db.prepare('SELECT admin_rate FROM services WHERE id=?').get(s1);
  assert.strictEqual(a.admin_rate, applyMarkup(10, 'fixed', 2.5));     // 12.5
  assert.strictEqual(setting('global_markup_type'), 'fixed');
});

t('a zero markup is valid and applies exactly (no hidden default of 25)', () => {
  gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 0 });
  assert.strictEqual(db.prepare('SELECT admin_rate FROM services WHERE id=?').get(s1).admin_rate, 10);
  assert.strictEqual(setting('global_markup_value'), '0');
});

t('a failure part-way through rolls back BOTH settings and services together', () => {
  gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 20 });
  const before = snapshot();
  // A row whose provider rate is not numeric makes the rate invalid mid-loop.
  const bad = addService('svc-bad', 'not-a-number', 1);
  assert.throws(() => gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 40 }), /invalid rate/);
  db.prepare('DELETE FROM services WHERE id=?').run(bad);
  assert.strictEqual(snapshot(), before, 'a partial apply must never persist');
});

t('the apply stores plain numbers only (never NaN or a string) in the services table', () => {
  gm.applyGlobalMarkup(db, { markup_type: 'percent', markup_value: 15.5 });
  for (const r of db.prepare('SELECT admin_rate, markup_value FROM services').all()) {
    assert.ok(Number.isFinite(r.admin_rate) && Number.isFinite(r.markup_value));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
if (fail > 0) process.exit(1);
