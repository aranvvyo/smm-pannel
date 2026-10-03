// ---------------------------------------------------------------------------
// Regression tests — the three incident areas:
//   P1  provider settings persistence (API keys, wallet IDs, transfer keys)
//   P2  provider service synchronization (mapping, duplicates, empty responses)
//   P3  customer ordering flow (wallet deduction, concurrency, failed orders)
//
// Usage: node scripts/test-regressions.mjs
//
// The suite runs against a THROWAWAY SQLite database (DB_FILE is honored
// at import time, so it is set before any server module loads) seeded by
// the SMM_TEST=1 path. No network calls are made: the demo adapter is
// local and global fetch is only stubbed for adapter-level tests.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// --- environment BEFORE any server module is imported (config.js reads it)
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-regress-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'regress.db');
process.env.ADMIN_EMAIL_1 = 'regress-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'regress-admin-pass-123';
process.env.SESSION_SECRET = 'regress-session-secret';
process.env.DEMO_SPEED = '1000'; // fast-forward the demo order lifecycle

// always clean up our own throwaway test database
process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { getDb, getExchangeRate } = await import('../server/db.js');
const { syncProviderServices } = await import('../server/lib/providerSync.js');
const { maskedProvider, createAdapter } = await import('../server/lib/provider.js');
const {
  placeOrder, quoteOrder, cancelOrder, syncOrderStatuses,
  InsufficientBalanceError, ProviderError,
} = await import('../server/lib/orderRouter.js');
const { applyMarkup } = await import('../server/lib/money.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const providersRouter = (await import('../server/routes/admin.providers.js')).default;
const settingsRouter = (await import('../server/routes/admin.settings.js')).default;
const clientOrdersRouter = (await import('../server/routes/client.orders.js')).default;

const db = getDb();
const dbFile = process.env.DB_FILE;

// ---------------------------------------------------------------------------
// Tiny harness (no framework — mirrors scripts/test-money.mjs style)
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e && e.message ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP-less router invocation: express Routers can be dispatched directly
// with a minimal req/res. Auth goes through real session rows.
// ---------------------------------------------------------------------------
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type() { return this; },
  };
  return res;
}

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {} } = {}) {
  const req = { method, url, query, body, cookies, headers: {}, ip: '127.0.0.1', user: null };
  const res = makeRes();
  let nextErr = null;
  await router(req, res, (e) => { nextErr = e || null; });
  if (nextErr) throw nextErr;
  return res;
}

function makeSession(userId) {
  const token = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, ip, expires_at, created_at) VALUES (?,?,?,?,?)'
  ).run(createHash('sha256').update(token).digest('hex'), userId, '127.0.0.1',
    Date.now() + 86_400_000, Date.now());
  return { instasmm_session: token };
}

function createUser(email, balancePaise) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?, 'client', 'Regression', ?, 0, 'active', 0, ?)`
  ).run(email, hashPassword('regress-pass-1'), balancePaise, now);
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

function firstDemoService() {
  const svc = db.prepare(
    `SELECT * FROM services
     WHERE provider_id = (SELECT id FROM providers WHERE adapter='demo') AND status=1
     ORDER BY id LIMIT 1`
  ).get();
  assert.ok(svc, 'seeded demo service missing — SMM_TEST=1 seeding must be active');
  return svc;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = 'regress-admin@test.dev';
const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get(ADMIN_EMAIL);
assert.ok(adminUser && adminUser.role === 'admin', 'admin seed missing');
const adminCookies = makeSession(adminUser.id);

console.log('P1 — provider settings persistence');

await t('admin save → database: provider created "Active" is stored active=1 and its API key is stored server-side only', async () => {
  const r = await call(providersRouter, {
    method: 'POST', url: '/',
    body: {
      name: 'Reg Provider', adapter: 'smmpost',
      api_url: 'https://api.example.com/smm', api_key: 'sk-reg-1234567890',
      active: 1, currency: 'USD', markup_type: 'percent', markup_value: 20,
    },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  const row = db.prepare('SELECT * FROM providers WHERE name=?').get('Reg Provider');
  assert.ok(row, 'provider row missing');
  assert.strictEqual(row.active, 1, 'an explicitly-active provider must be stored active (orders only route to active=1)');
  assert.strictEqual(row.api_key, 'sk-reg-1234567890', 'API key must persist in the database');
  assert.strictEqual(row.api_url, 'https://api.example.com/smm');
  // never exposed in the response
  assert.ok(!('api_key' in r.body) && !('api_url' in r.body), 'API key/URL must never be serialized');
  assert.strictEqual(r.body.has_api_key, true);
});

await t('admin reload → masked: GET /api/admin/providers never returns api_key or api_url', async () => {
  const r = await call(providersRouter, { method: 'GET', url: '/', cookies: adminCookies });
  assert.strictEqual(r.statusCode, 200);
  const leak = (r.body.providers || []).filter((p) => p.api_key || p.api_url);
  assert.strictEqual(leak.length, 0, 'secret fields leaked into the admin payload');
  const row = (r.body.providers || []).find((p) => p.name === 'Reg Provider');
  assert.ok(row && row.has_api_key === true && row.api_url_masked, 'masked facts must be present');
});

await t('admin edit with blank endpoint/key keeps the stored config (settings never disappear on edit)', async () => {
  const prov = db.prepare('SELECT * FROM providers WHERE name=?').get('Reg Provider');
  const r = await call(providersRouter, {
    method: 'PATCH', url: `/${prov.id}`,
    body: { name: 'Reg Provider v2', markup_value: 30, api_url: '', api_key: '' },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.prepare('SELECT * FROM providers WHERE id=?').get(prov.id);
  assert.strictEqual(after.api_url, 'https://api.example.com/smm',
    'blank api_url must KEEP the stored endpoint (the edit form opens with an empty field)');
  assert.strictEqual(after.api_key, 'sk-reg-1234567890', 'blank api_key must KEEP the stored key');
  assert.strictEqual(after.markup_value, 30);
  assert.strictEqual(after.name, 'Reg Provider v2');
});

await t('admin edit with a whitespace-only key keeps the stored key; a real key replaces it', async () => {
  const prov = db.prepare('SELECT * FROM providers WHERE name=?').get('Reg Provider v2');
  let r = await call(providersRouter, {
    method: 'PATCH', url: `/${prov.id}`, body: { api_key: '   ' }, cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200);
  let after = db.prepare('SELECT * FROM providers WHERE id=?').get(prov.id);
  assert.strictEqual(after.api_key, 'sk-reg-1234567890', 'whitespace-only key = keep');
  r = await call(providersRouter, {
    method: 'PATCH', url: `/${prov.id}`, body: { api_key: 'sk-reg-NEWKEY-999' }, cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200);
  after = db.prepare('SELECT * FROM providers WHERE id=?').get(prov.id);
  assert.strictEqual(after.api_key, 'sk-reg-NEWKEY-999', 'an entered key must replace the stored one');
});

await t('Apirone wallet ID + transfer key persist in the settings table and never appear in any API response', async () => {
  const r = await call(settingsRouter, {
    method: 'POST', url: '/',
    body: {
      apirone_account_id: 'acct-reg-1',
      apirone_transfer_key: 'tk-reg-supersecret-123',
      apirone_webhook_token: 'wh-reg-token-456',
      exchange_rate: 123,
    },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.apirone.configured, true);
  // NOTE: the POST response carries the masked apirone section only;
  // the top-level payment_mode is returned by GET /.
  assert.strictEqual(r.body.apirone.mode, 'live');

  // persisted in the database (the only storage — no memory/file cache)
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='apirone_account_id'").get().value, 'acct-reg-1');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='apirone_transfer_key'").get().value, 'tk-reg-supersecret-123');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='apirone_webhook_token'").get().value, 'wh-reg-token-456');

  // reload flow: values survive a reload AND are never echoed back
  const g = await call(settingsRouter, { method: 'GET', url: '/', cookies: adminCookies });
  const bodyStr = JSON.stringify(g.body);
  assert.ok(!bodyStr.includes('tk-reg-supersecret-123'), 'transfer key leaked into a response');
  assert.ok(!bodyStr.includes('acct-reg-1'), 'account id leaked into a response');
  assert.ok(!bodyStr.includes('wh-reg-token-456'), 'webhook token leaked into a response');
  assert.ok(!('apirone_account_id' in g.body.settings) && !('apirone_transfer_key' in g.body.settings));
  assert.strictEqual(g.body.settings.exchange_rate, '123', 'non-secret settings reload from the DB');
  assert.strictEqual(g.body.payment_mode, 'live', 'GET reports the payment mode');
  assert.strictEqual(getExchangeRate(), 123);
});

await t('saved settings + provider keys are durable in the database file (a fresh connection reads them)', async () => {
  const fresh = new DatabaseSync(dbFile);
  try {
    const rate = fresh.prepare("SELECT value FROM settings WHERE key='exchange_rate'").get();
    assert.strictEqual(rate.value, '123');
    const prov = fresh.prepare('SELECT api_key, api_url, active FROM providers WHERE name=?').get('Reg Provider v2');
    assert.strictEqual(prov.api_key, 'sk-reg-NEWKEY-999');
    assert.strictEqual(prov.api_url, 'https://api.example.com/smm');
    assert.strictEqual(prov.active, 1);
  } finally {
    fresh.close();
  }
});

await t('provider without an endpoint: test/sync return a clean 502 (never an unhandled 500)', async () => {
  const r = await call(providersRouter, {
    method: 'POST', url: '/',
    body: { name: 'Broken Provider', api_key: 'sk-broken-12345678' },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 201);
  const broken = db.prepare('SELECT * FROM providers WHERE name=?').get('Broken Provider');
  const testRes = await call(providersRouter, { method: 'POST', url: `/${broken.id}/test`, body: {}, cookies: adminCookies });
  assert.strictEqual(testRes.statusCode, 502, `expected 502, got ${testRes.statusCode}`);
  const syncRes = await call(providersRouter, { method: 'POST', url: `/${broken.id}/sync-services`, body: {}, cookies: adminCookies });
  assert.strictEqual(syncRes.statusCode, 502, `expected 502, got ${syncRes.statusCode}`);
  const refreshed = db.prepare('SELECT * FROM providers WHERE id=?').get(broken.id);
  assert.ok(refreshed.last_error && refreshed.last_error.length > 0, 'the failure is recorded for the admin');
  assert.ok(!String(refreshed.last_error).includes('sk-broken-12345678'), 'the stored key must never land in last_error');
});

console.log('P2 — provider service synchronization');

await t('smmpost adapter maps service id, name, category, rate/price, min, max, avg completion time, quality, refill/cancel', async () => {
  const originalFetch = globalThis.fetch;
  const payload = [
    { service: '1', name: 'Followers A', category: 'Instagram', rate: '12.5', min: '50', max: '100000',
      type: 'Default', refill: true, cancel: '1', avg: '1-2 hours', quality: 'BEST', description: 'Followers A desc' },
    { service: '2', name: 'Likes B', category: 'Instagram', price: '7.25', min: 5, max: 50, avg: 30 },
  ];
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: opts.body };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  try {
    const adapter = createAdapter('smmpost', { api_url: 'https://api.example.com/smm', api_key: 'sk-parse-1', currency: 'USD' });
    const svcs = await adapter.listServices();
    assert.strictEqual(svcs.length, 2);
    assert.strictEqual(svcs[0].service, '1');
    assert.strictEqual(svcs[0].name, 'Followers A');
    assert.strictEqual(svcs[0].category, 'Instagram');
    assert.strictEqual(svcs[0].rate, 12.5);
    assert.strictEqual(svcs[0].min, 50); // '50' → 50
    assert.strictEqual(svcs[0].max, 100000);
    assert.strictEqual(svcs[0].avg, '1-2 hours', 'average completion time must be parsed');
    assert.strictEqual(svcs[0].quality, 'BEST', 'quality tier must be parsed');
    assert.strictEqual(svcs[0].refill, 1);
    assert.strictEqual(svcs[0].cancel, 1);
    assert.strictEqual(svcs[1].rate, 7.25, 'price field is a rate fallback');
    assert.strictEqual(svcs[1].avg, '30 min', 'numeric avg is minutes in the SMM POST contract');
    assert.strictEqual(svcs[1].quality, null);
    // the key travels in the POST body only — never in the URL
    assert.strictEqual(captured.url, 'https://api.example.com/smm');
    assert.ok(String(captured.body).includes('key=sk-parse-1'));
    assert.ok(!captured.url.includes('sk-parse-1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t('smmpost adapter parses object-keyed service maps and redacts the API key from error strings', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ '10': { name: 'Obj Svc', category: 'X', rate: 9.5, avg: '5 min', quality: 'HIGH' } }),
  });
  try {
    const adapter = createAdapter('smmpost', { api_url: 'https://api.example.com/smm', api_key: 'sk-live-secret-99', currency: 'USD' });
    const svcs = await adapter.listServices();
    assert.strictEqual(svcs[0].service, '10');
    assert.strictEqual(svcs[0].name, 'Obj Svc');
    assert.strictEqual(svcs[0].rate, 9.5);
    assert.strictEqual(svcs[0].avg, '5 min');
    assert.strictEqual(svcs[0].quality, 'HIGH');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ error: 'invalid key sk-live-secret-99' }),
  });
  try {
    const adapter = createAdapter('smmpost', { api_url: 'https://api.example.com/smm', api_key: 'sk-live-secret-99', currency: 'USD' });
    let threw = null;
    try { await adapter.balance(); } catch (e) { threw = e; }
    assert.ok(threw, 'the provider error must surface');
    assert.ok(!String(threw.message).includes('sk-live-secret-99'), 'API key leaked into the error message');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const SYNC_PROV_NAME = 'Sync Prov';
function syncProvider() {
  const row = db.prepare('SELECT * FROM providers WHERE name=?').get(SYNC_PROV_NAME);
  if (row) return row;
  const now = Date.now();
  const id = db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, currency, markup_type, markup_value, created_at, updated_at)
     VALUES (?, 'smmpost', 'https://sync.example.com/api', 'sk-sync-1', 1, 'USD', 'percent', 25, ?, ?)`
  ).run(SYNC_PROV_NAME, now, now).lastInsertRowid;
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id);
}

await t('sync saves id, name, category, rate, min, max, avg completion time (speed_hint) and quality; markup derives admin_rate', async () => {
  const provider = syncProvider();
  const list = [
    { service: '101', name: 'Followers X', category: 'Instagram', rate: '12.5', min: '50', max: '100000',
      type: 'Default', refill: true, cancel: '1', avg: '2-3 hours', quality: 'HIGH', description: 'd1' },
    // The adapter layer formats numeric minutes as "N min" before the
    // sync layer ever sees the entry — mirror that here.
    { service: '102', name: 'Likes Y', category: 'Instagram', rate: 7.25, min: 10, max: 5000, avg: '45 min' },
  ];
  const out = syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(out.added, 2);
  assert.strictEqual(out.skipped, 0);

  const s1 = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('101');
  assert.ok(s1, 'service 101 missing');
  assert.strictEqual(s1.provider_id, provider.id);
  assert.strictEqual(s1.name, 'Followers X');
  assert.strictEqual(s1.min, 50, 'string min must be saved as a number');
  assert.strictEqual(s1.max, 100000);
  assert.strictEqual(s1.provider_rate, 12.5);
  assert.strictEqual(s1.admin_rate, applyMarkup(12.5, 'percent', 25), 'new services carry the markup-derived selling rate');
  assert.strictEqual(s1.speed_hint, '2-3 hours', 'average completion time must be saved');
  assert.strictEqual(s1.quality, 'HIGH', 'quality must be saved');
  assert.strictEqual(s1.refill, 1);
  assert.strictEqual(s1.cancel, 1);
  assert.strictEqual(s1.type, 'Default');
  // category was created from the provider payload (sync derives the
  // slug from the upstream service id — it does not reuse seed slugs)
  const cat = db.prepare("SELECT * FROM categories WHERE slug='srvc-101'").get();
  assert.ok(cat && cat.name === 'Instagram' && s1.category_id === cat.id);

  const s2 = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('102');
  assert.strictEqual(s2.speed_hint, '45 min');
  assert.strictEqual(s2.quality, null);
  assert.strictEqual(s2.admin_rate, applyMarkup(7.25, 'percent', 25));
});

await t('re-sync is idempotent: no duplicate rows, live pricing refreshed, admin-set markup preserved', async () => {
  const provider = syncProvider();
  const before = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('101');
  const list = [
    { service: '101', name: 'Followers X (renamed)', category: 'Instagram', rate: '20', min: '60', max: '200000',
      avg: '1 hour', quality: 'STANDARD', refill: false, cancel: false },
  ];
  const out = syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.updated, 1);
  const count = db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=? AND provider_service_id=?')
    .get(provider.id, '101').c;
  assert.strictEqual(count, 1, 're-sync must not create duplicate service rows');

  const after = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('101');
  assert.strictEqual(after.name, 'Followers X (renamed)', 'name refreshed from upstream');
  assert.strictEqual(after.provider_rate, 20, 'live provider pricing must be refreshed');
  assert.strictEqual(after.min, 60);
  assert.strictEqual(after.max, 200000);
  assert.strictEqual(after.speed_hint, '1 hour');
  assert.strictEqual(after.quality, 'STANDARD');
  assert.strictEqual(after.admin_rate, before.admin_rate, 'an admin-set per-service markup must never be clobbered by a re-sync');
});

await t('malformed provider entries are skipped — never stored, never wiping valid rows', async () => {
  const provider = syncProvider();
  const list = [
    { service: '', name: 'No id' },
    { service: '103', name: '' },
    { service: '104', name: 'No rate', rate: 'abc' },
    { service: '105', name: 'Good Entry', rate: 5.5, avg: '10 min', quality: 'OK' },
  ];
  const out = syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(out.skipped, 3);
  assert.strictEqual(out.added, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM services WHERE provider_service_id='105'").get().c, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM services WHERE provider_service_id IN ('103','104')").get().c, 0);
  const good = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('105');
  assert.strictEqual(good.speed_hint, '10 min');
  assert.strictEqual(good.quality, 'OK');
});

await t('sync endpoint refuses an empty provider response without touching the catalog', async () => {
  const demoProv = db.prepare("SELECT * FROM providers WHERE adapter='demo'").get();
  const before = db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(demoProv.id).c;
  const r = await call(providersRouter, { method: 'POST', url: `/${demoProv.id}/sync-services`, body: {}, cookies: adminCookies });
  assert.strictEqual(r.statusCode, 400, `expected 400, got ${r.statusCode}`);
  assert.ok(String(r.body.error).includes('no services'));
  const after = db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(demoProv.id).c;
  assert.strictEqual(after, before, 'an empty API response must not overwrite the valid catalog');
});

await t('maskedProvider never leaks api_key/api_url', async () => {
  const provider = syncProvider();
  const masked = maskedProvider(provider);
  assert.ok(masked);
  assert.ok(!('api_key' in masked) && !('api_url' in masked));
  assert.strictEqual(masked.has_api_key, true);
  assert.strictEqual(masked.service_count,
    db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(provider.id).c);
});

console.log('P3 — customer ordering flow');

await t('order placement: wallet deducted exactly once, ledger row written with the correct balance_after', async () => {
  const svc = firstDemoService();
  const user = createUser('happy@test.dev', 500000);
  const before = user.wallet_balance;
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/regress-happy', quantity: svc.min });
  assert.ok(order.order_ref.startsWith('ORD-'));
  assert.strictEqual(order.status, 'PENDING');
  assert.strictEqual(order.quantity, svc.min);

  const after = db.prepare('SELECT wallet_balance, total_spent_inr FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, before - order.price_inr, 'balance must drop by exactly the order price');
  assert.strictEqual(after.total_spent_inr, order.price_inr);
  const tx = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='order' ORDER BY id DESC LIMIT 1").get(user.id);
  assert.ok(tx, 'ledger row missing');
  assert.strictEqual(tx.amount_inr, -order.price_inr);
  assert.strictEqual(tx.balance_after, after.wallet_balance);
  const stored = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.strictEqual(stored.price_inr, order.price_inr);
  const expectedBase = Math.round(svc.min * (Number(svc.provider_rate) / 1000) * 100);
  assert.strictEqual(stored.base_cost_inr, expectedBase, 'base cost must be the provider-rate price');
  assert.ok(stored.provider_order_id, 'provider order id must be recorded');
});

await t('quote returns only display-safe fields (no provider rate / base cost / markup math)', async () => {
  const svc = firstDemoService();
  const q = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: null, noProfit: false });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.final, q.price);
  for (const k of ['provider_rate', 'admin_rate', 'base', 'base_cost_inr', 'markup_value', 'sellRate']) {
    assert.ok(!(k in q), `${k} must never be exposed to clients`);
  }
});

await t('client order payload hides provider order id, provider id and base cost', async () => {
  const svc = firstDemoService();
  const user = createUser('mask@test.dev', 500000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/regress-mask', quantity: svc.min });
  for (const k of ['provider_order_id', 'provider_id', 'base_cost_inr', 'provider_charge', 'provider_currency']) {
    assert.ok(!(k in order), `${k} must not leak to the client`);
  }
});

await t('concurrent orders cannot double-spend: exactly the affordable number succeed, balance never goes negative', async () => {
  const svc = firstDemoService();
  const quote = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: null, noProfit: false });
  const balance = 3 * quote.final; // exactly 3 orders affordable
  const user = createUser('race@test.dev', balance);
  // every concurrent request authenticates against the SAME pre-debit
  // snapshot — the classic lost-update race window.
  const snapshot = { ...user };
  const links = ['r1', 'r2', 'r3', 'r4', 'r5'].map((s) => `https://instagram.com/race-${s}`);
  const results = await Promise.allSettled(
    links.map((link) => placeOrder({ user: snapshot, serviceId: svc.id, link, quantity: svc.min }))
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 3, `exactly 3 orders should succeed, got ${ok.length}`);
  assert.strictEqual(bad.length, 2);
  for (const r of bad) {
    assert.ok(r.reason instanceof InsufficientBalanceError, 'the 2 unfunded orders must fail with insufficient balance');
  }
  const final = db.prepare('SELECT wallet_balance, total_spent_inr FROM users WHERE id=?').get(user.id);
  assert.strictEqual(final.wallet_balance, 0, 'balance must be exactly zero — no over/under charge');
  assert.strictEqual(final.total_spent_inr, balance, 'total spent must match the 3 placed orders');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'").get(user.id).c, 3);
});

await t('concurrent coupon redemption cannot over-redeem a usage-limited coupon (rollback is safe)', async () => {
  const svc = firstDemoService();
  const user = createUser('couponrace@test.dev', 1000000);
  const now = Date.now();
  db.prepare(
    `INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
     VALUES ('RACE10','percent',10,0,?,?,1,1,0,?)`
  ).run(now, now + 86_400_000, now);
  const snapshot = { ...user };
  const results = await Promise.allSettled([
    placeOrder({ user: snapshot, serviceId: svc.id, link: 'https://instagram.com/cr-1', quantity: svc.min, couponCode: 'RACE10' }),
    placeOrder({ user: snapshot, serviceId: svc.id, link: 'https://instagram.com/cr-2', quantity: svc.min, couponCode: 'RACE10' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactly one order may redeem a usage_limit=1 coupon');
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].reason.code, 'BAD_COUPON');
  assert.strictEqual(db.prepare("SELECT used_count FROM coupons WHERE code='RACE10'").get().used_count, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'").get(user.id).c, 1,
    'the rolled-back order must not leave a ledger row');
  const standing = db.prepare('SELECT * FROM orders WHERE user_id=?').get(user.id);
  const bal = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(bal.wallet_balance, 1000000 - (standing.price_inr - standing.discount_inr),
    'only the standing order may be charged');
});

await t('provider failure ⇒ no debit, no order row, ProviderError surfaced', async () => {
  const svc = firstDemoService();
  const user = createUser('failorder@test.dev', 500000);
  await assert.rejects(
    placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/fail-me', quantity: svc.min }),
    (e) => e instanceof ProviderError
  );
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 500000, 'a rejected order must never debit the wallet');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM orders WHERE link LIKE '%fail-me%'").get().c, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=?").get(user.id).c, 0);
});

await t('insufficient balance ⇒ clean 402-class error before any provider call, no debit', async () => {
  const svc = firstDemoService();
  const user = createUser('poor@test.dev', 1);
  await assert.rejects(
    placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/x', quantity: svc.min }),
    (e) => e instanceof InsufficientBalanceError
  );
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 1);
});

await t('order API maps insufficient balance → 402 and provider failure → generic 502 (no supplier details leaked)', async () => {
  const svc = firstDemoService();
  const poor = createUser('poorapi@test.dev', 1);
  const poorCookies = makeSession(poor.id);
  let r = await call(clientOrdersRouter, {
    method: 'POST', url: '/',
    body: { serviceId: svc.id, link: 'https://instagram.com/x', quantity: svc.min },
    cookies: poorCookies,
  });
  assert.strictEqual(r.statusCode, 402);
  assert.strictEqual(r.body.code, 'INSUFFICIENT_BALANCE');

  const funded = createUser('fundedapi@test.dev', 500000);
  const fundedCookies = makeSession(funded.id);
  r = await call(clientOrdersRouter, {
    method: 'POST', url: '/',
    body: { serviceId: svc.id, link: 'https://instagram.com/fail-now', quantity: svc.min },
    cookies: fundedCookies,
  });
  assert.strictEqual(r.statusCode, 502);
  assert.strictEqual(r.body.code, 'PROVIDER_ERROR');
  const bodyStr = JSON.stringify(r.body);
  assert.ok(!bodyStr.includes('simulated upstream failure'), 'provider error text must never reach the client');
  assert.ok(!bodyStr.includes('demo'), 'supplier identity must never reach the client');
  const bal = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(funded.id);
  assert.strictEqual(bal.wallet_balance, 500000, 'nothing may be charged for a failed order');
});

await t('cancel of a pending order refunds the undelivered amount and writes a refund ledger row', async () => {
  const svc = db.prepare(
    `SELECT * FROM services
     WHERE provider_id = (SELECT id FROM providers WHERE adapter='demo') AND cancel=1 AND status=1
     ORDER BY id LIMIT 1`
  ).get();
  assert.ok(svc, 'need a seeded service that supports cancel');
  const user = createUser('cancel@test.dev', 100000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/regress-cancel', quantity: svc.min });
  const out = await cancelOrder({ admin: adminUser, orderId: order.id });
  assert.strictEqual(out.status, 'CANCELED');
  assert.strictEqual(out.refund_inr, order.price_inr, 'a pending order has nothing delivered → full refund');
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 100000, 'the refund must restore the pre-order balance');
  const refundTx = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='refund'").get(user.id);
  assert.ok(refundTx, 'the refund must be recorded in the ledger');
  assert.strictEqual(refundTx.amount_inr, order.price_inr);
  assert.strictEqual(refundTx.balance_after, 100000);
});

await t('status ticker advances a demo order PENDING → COMPLETED/PARTIAL with correct counts', async () => {
  const svc = firstDemoService();
  const user = createUser('ticker@test.dev', 500000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/regress-ticker', quantity: svc.min });
  // DEMO_SPEED=1000: the whole lifecycle completes in well under a second.
  await new Promise((res) => setTimeout(res, 1500));
  await syncOrderStatuses();
  const done = db.prepare('SELECT status, start_count, remains, quantity FROM orders WHERE id=?').get(order.id);
  assert.notStrictEqual(done.status, 'PENDING', 'the ticker must advance the order');
  assert.ok(['COMPLETED', 'PARTIAL', 'IN_PROGRESS'].includes(done.status), `unexpected status ${done.status}`);
  if (done.status === 'COMPLETED') {
    assert.strictEqual(done.start_count, done.quantity);
    assert.strictEqual(done.remains, 0);
  }
});

await t('production smmpost adapter drives the full order flow: add → order row → live status sync', async () => {
  const originalFetch = globalThis.fetch;
  const provider = syncProvider();
  const synced = syncProviderServices(db, { provider, list: [
    { service: '201', name: 'Flow Test Followers', category: 'Instagram', rate: '12.5', min: '50', max: '100000', avg: '1-2 hours', quality: 'HIGH', refill: true, cancel: '1' },
  ], globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(synced.added, 1);
  const svc = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('201');
  const user = createUser('flow@test.dev', 500000);
  const before = user.wallet_balance;

  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = String(opts.body);
    calls.push({ url: String(url), body });
    if (body.includes('action=add')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ order: 'SUP-991', status: 'PENDING', charge: 0.6, currency: 'USD' }) };
    }
    // action=status (batch): response keyed by the provider order id
    return { ok: true, status: 200, text: async () => JSON.stringify({ 'SUP-991': { status: 'COMPLETED', start_count: 50, remains: 0, charge: 0.6 } }) };
  };
  try {
    const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/flow-test', quantity: 50 });
    assert.strictEqual(order.status, 'PENDING');
    const stored = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    assert.strictEqual(stored.provider_order_id, 'SUP-991', 'the provider order id must be recorded');
    assert.strictEqual(stored.provider_charge, 0.6, 'the provider charge must be recorded');
    assert.strictEqual(stored.provider_currency, 'USD');
    const after = db.prepare('SELECT wallet_balance, total_spent_inr FROM users WHERE id=?').get(user.id);
    assert.strictEqual(after.wallet_balance, before - order.price_inr, 'wallet debited exactly once');
    assert.strictEqual(after.total_spent_inr, order.price_inr);
    assert.ok(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'").get(user.id).c >= 1, 'ledger row missing');

    const addCall = calls.find((c) => c.body.includes('action=add'));
    assert.ok(addCall, 'no add call reached the provider');
    assert.strictEqual(addCall.url, 'https://sync.example.com/api');
    assert.ok(addCall.body.includes('service=201') && addCall.body.includes('quantity=50'));
    assert.ok(addCall.body.includes('link=https%3A%2F%2Finstagram.com%2Fflow-test'));
    assert.ok(addCall.body.includes('key=sk-sync-1'), 'the key travels in the POST body');
    assert.ok(!addCall.url.includes('sk-sync-1'), 'the key must never travel in the URL');

    // Live status sync through the SAME production adapter: PENDING → COMPLETED.
    await syncOrderStatuses();
    const done = db.prepare('SELECT status, start_count, remains FROM orders WHERE id=?').get(order.id);
    assert.strictEqual(done.status, 'COMPLETED');
    assert.strictEqual(done.start_count, 50);
    assert.strictEqual(done.remains, 0);
    const statusCall = calls.find((c) => c.body.includes('action=status'));
    assert.ok(statusCall && statusCall.body.includes('orders=SUP-991'), 'the batch status query must carry the provider order id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
