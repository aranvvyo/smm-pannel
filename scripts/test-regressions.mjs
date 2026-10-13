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
const { syncProviderServices, categoryKey } = await import('../server/lib/providerSync.js');
const { maskedProvider, createAdapter, registerProviderAdapter } = await import('../server/lib/provider.js');
const {
  placeOrder, quoteOrder, cancelOrder, syncOrderStatuses,
  userOrders, orderWithService,
  InsufficientBalanceError, ProviderError,
} = await import('../server/lib/orderRouter.js');
const { applyMarkup } = await import('../server/lib/money.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const providersRouter = (await import('../server/routes/admin.providers.js')).default;
const settingsRouter = (await import('../server/routes/admin.settings.js')).default;
const adminAuthRouter = (await import('../server/routes/admin.auth.js')).default;
const adminServicesRouter = (await import('../server/routes/admin.services.js')).default;
const clientAuthRouter = (await import('../server/routes/client.auth.js')).default;
const { default: clientOrdersRouter, quoteRouter } = await import('../server/routes/client.orders.js');
const clientServicesRouter = (await import('../server/routes/client.services.js')).default;

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
    cookie() { return this; },
    clearCookie() { return this; },
  };
  return res;
}

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {}, headers = {}, remoteAddress = undefined } = {}) {
  const req = { method, url, query, body, cookies, headers, ip: '127.0.0.1', user: null };
  // rateLimitIp() reads the UNSPOOFABLE socket address — supply one
  // to exercise per-IP throttle buckets (the default is 'unknown').
  if (remoteAddress) req.socket = { remoteAddress };
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
  // Category is the canonical row for the provider's category
  // NAME — the slug is derived from the normalized name (one
  // row per name), never from the upstream service id.
  const cat = db.prepare('SELECT * FROM categories WHERE slug=?').get(categoryKey('Instagram'));
  assert.ok(cat && cat.name === 'Instagram' && s1.category_id === cat.id);
  // The legacy per-service slug must no longer be created.
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM categories WHERE slug='srvc-101'").get().c, 0);

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

await t('sync groups repeated provider category names into ONE category (no per-service categories)', async () => {
  const provider = syncProvider();
  const list = [
    // Fresh, never-reused provider service ids: the full-flow
    // test further down also syncs '201' and asserts added===1,
    // so this fixture must not occupy that id first.
    { service: '241', name: 'Auto Likes', category: 'Instagram Followers', rate: 9, min: 10, max: 1000 },
    { service: '242', name: 'Real Likes', category: 'Instagram Followers', rate: 11, min: 20, max: 2000 },
    { service: '243', name: 'Fast Likes', category: 'Instagram Followers', rate: 13, min: 30, max: 3000 },
  ];
  const out = syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(out.added, 3);
  assert.strictEqual(out.skipped, 0);
  const rows = db.prepare('SELECT * FROM categories WHERE slug=?').all(categoryKey('Instagram Followers'));
  assert.strictEqual(rows.length, 1, 'three services in the same category must share ONE category row');
  const inCat = db.prepare('SELECT COUNT(*) c FROM services WHERE category_id=?').get(rows[0].id).c;
  assert.strictEqual(inCat, 3, 'all three services must point at the shared category');
});

await t('sync keeps genuinely different categories separate (text and emoji variants)', async () => {
  const provider = syncProvider();
  const list = [
    { service: '211', name: 'Subs', category: 'YouTube Subscribers', rate: 9, min: 10, max: 1000 },
    { service: '212', name: 'Views', category: 'YouTube Views', rate: 2, min: 100, max: 100000 },
    // An emoji marker is meaningful — it must NOT collapse into
    // the plain-text category (the name hash keeps them apart).
    { service: '213', name: 'Subs Fire', category: 'YouTube Subscribers 🔥', rate: 10, min: 10, max: 1000 },
  ];
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  const slugs = [
    categoryKey('YouTube Subscribers'),
    categoryKey('YouTube Views'),
    categoryKey('YouTube Subscribers 🔥'),
  ];
  assert.notStrictEqual(slugs[0], slugs[2], 'emoji variant must stay distinct');
  assert.notStrictEqual(slugs[0], slugs[1]);
  assert.notStrictEqual(slugs[1], slugs[2]);
  const names = slugs.map((s) => db.prepare('SELECT name FROM categories WHERE slug=?').get(s)?.name);
  assert.deepStrictEqual(names, ['YouTube Subscribers', 'YouTube Views', 'YouTube Subscribers 🔥']);
});

await t('sync merges case/whitespace-only category variants into one category', async () => {
  const provider = syncProvider();
  const list = [
    { service: '221', name: 'Members A', category: 'Telegram Members', rate: 5, min: 10, max: 1000 },
    { service: '222', name: 'Members B', category: '  telegram members ', rate: 6, min: 10, max: 1000 },
    { service: '223', name: 'Members C', category: 'Telegram   Members', rate: 7, min: 10, max: 1000 },
  ];
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  // Case and spacing are formatting noise — they must all map
  // to a single canonical row.
  const merged = db.prepare("SELECT COUNT(*) c FROM categories WHERE lower(replace(name,' ',''))='telegrammembers'").get().c;
  assert.strictEqual(merged, 1, 'case/whitespace variants must merge into one category row');
  const cat = db.prepare('SELECT * FROM categories WHERE slug=?').get(categoryKey('Telegram Members'));
  assert.ok(cat, 'canonical category missing');
  const inCat = db.prepare('SELECT COUNT(*) c FROM services WHERE category_id=?').get(cat.id).c;
  assert.strictEqual(inCat, 3, 'all variant services must point at the canonical category');
});

await t('re-sync re-points legacy per-service categories onto the canonical category', async () => {
  const provider = syncProvider();
  // Simulate a row from the buggy slug era: a per-service
  // category whose name matches a real category.
  db.prepare("INSERT INTO categories (name, slug, icon, sort, active) VALUES ('Legacy Cat','srvc-legacy-999','package',0,1)").run();
  const legacyCat = db.prepare("SELECT id FROM categories WHERE slug='srvc-legacy-999'").get();
  db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate,
       min, max, status, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`
  ).run(legacyCat.id, provider.id, '999', 'Legacy Service', 4.5, applyMarkup(4.5, 'percent', 25), 10, 1000, Date.now());

  syncProviderServices(db, { provider, list: [{ service: '999', name: 'Legacy Service', category: 'Legacy Cat', rate: 4.5, min: 10, max: 1000 }], globalMarkup: { type: 'percent', value: 25 } });

  const canonical = db.prepare('SELECT * FROM categories WHERE slug=?').get(categoryKey('Legacy Cat'));
  assert.ok(canonical, 'canonical category row must exist');
  const svc = db.prepare('SELECT * FROM services WHERE provider_service_id=?').get('999');
  assert.strictEqual(svc.category_id, canonical.id, 're-sync must re-point the service to the canonical category');
  assert.notStrictEqual(svc.category_id, legacyCat.id);
  // Non-destructive: the legacy row stays, but is now empty,
  // so it no longer surfaces anywhere in the UI.
  const legacyCount = db.prepare('SELECT COUNT(*) c FROM services WHERE category_id=?').get(legacyCat.id).c;
  assert.strictEqual(legacyCount, 0);
});

await t('GET /api/services: every category returns only its own services, counts are consistent', async () => {
  const provider = syncProvider();
  const list = [
    { service: '301', name: 'Cat A One', category: 'Alpha Services', rate: 8, min: 10, max: 1000 },
    { service: '302', name: 'Cat A Two', category: 'Alpha Services', rate: 9, min: 10, max: 1000 },
    { service: '303', name: 'Cat B One', category: 'Beta Services', rate: 7, min: 10, max: 1000 },
  ];
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });

  const clientUser = createUser('svccat@test.dev', 1000);
  const cookies = makeSession(clientUser.id);
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies });
  assert.strictEqual(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.provider_configured, true, 'an active provider exists');
  const byName = new Map(r.body.categories.map((c) => [c.name, c]));
  assert.ok(byName.has('Alpha Services') && byName.has('Beta Services'));
  assert.strictEqual(byName.get('Alpha Services').services.length, 2);
  assert.strictEqual(byName.get('Beta Services').services.length, 1);
  // Every service carries its category_id and it matches the
  // enclosing category — the invariant the order page filters on.
  for (const c of r.body.categories) {
    for (const s of c.services) {
      assert.strictEqual(s.category_id, c.id, `service ${s.name} must carry its category_id`);
      assert.ok(!('provider_rate' in s) && !('admin_rate' in s), 'no cost fields may leak to clients');
    }
  }
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

await t('quote HTTP endpoint prices the exact requested quantity (server-side, input-bound)', async () => {
  const svc = firstDemoService();
  const user = createUser('quotehttp@test.dev', 1000000);
  const cookies = makeSession(user.id);
  const q1 = await call(quoteRouter, { method: 'POST', url: '/quote', body: { serviceId: svc.id, quantity: svc.min, coupon_code: null }, cookies });
  assert.strictEqual(q1.statusCode, 200, JSON.stringify(q1.body));
  assert.strictEqual(q1.body.ok, true);
  // The response echoes the exact inputs it priced — the
  // client ties its displayed quote to these values.
  assert.strictEqual(q1.body.serviceId, svc.id);
  assert.strictEqual(q1.body.quantity, svc.min);
  assert.strictEqual(typeof q1.body.price, 'number');
  assert.strictEqual(typeof q1.body.final, 'number');
  assert.strictEqual(q1.body.invalidCoupon, false);
  assert.strictEqual(q1.body.belowMin, false);
  // Price must scale with the requested quantity — proof the
  // server computed it for these exact inputs. Prices are
  // integer paise, so a doubled quantity is double within
  // ±1 paise of independent rounding.
  const q2 = await call(quoteRouter, { method: 'POST', url: '/quote', body: { serviceId: svc.id, quantity: svc.min * 2, coupon_code: null }, cookies });
  assert.strictEqual(q2.statusCode, 200);
  assert.strictEqual(q2.body.quantity, svc.min * 2);
  const doubled = 2 * q1.body.final;
  assert.ok(q2.body.final >= doubled - 1 && q2.body.final <= doubled + 1,
    `a doubled quantity must quote ~double the price (got ${q1.body.final} -> ${q2.body.final})`);
  // No cost fields may leak to clients.
  for (const k of ['provider_rate', 'admin_rate', 'base_cost_inr', 'markup_value']) {
    assert.ok(!(k in q1.body), `${k} must never be exposed to clients`);
  }
});

await t('quote HTTP endpoint rejects an out-of-range quantity with 400 BAD_QTY', async () => {
  const svc = firstDemoService();
  const user = createUser('quotebounds@test.dev', 1000000);
  const cookies = makeSession(user.id);
  const lo = await call(quoteRouter, { method: 'POST', url: '/quote', body: { serviceId: svc.id, quantity: svc.min - 1, coupon_code: null }, cookies });
  assert.strictEqual(lo.statusCode, 400, `expected 400, got ${lo.statusCode}: ${JSON.stringify(lo.body)}`);
  assert.strictEqual(lo.body.code, 'BAD_QTY');
  const hi = await call(quoteRouter, { method: 'POST', url: '/quote', body: { serviceId: svc.id, quantity: svc.max + 1, coupon_code: null }, cookies });
  assert.strictEqual(hi.statusCode, 400);
  assert.strictEqual(hi.body.code, 'BAD_QTY');
});

await t('quote HTTP endpoint flags an unknown coupon without failing or discounting', async () => {
  const svc = firstDemoService();
  const user = createUser('quotecoupon@test.dev', 1000000);
  const cookies = makeSession(user.id);
  const r = await call(quoteRouter, { method: 'POST', url: '/quote', body: { serviceId: svc.id, quantity: svc.min, coupon_code: 'NO-SUCH-COUPON' }, cookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.invalidCoupon, true, 'an unknown coupon must be flagged, not silently ignored');
  assert.strictEqual(r.body.discount, 0, 'an invalid coupon must not discount anything');
  assert.strictEqual(r.body.final, r.body.price, 'the final price must be the undiscounted sale price');
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

await t('provider refusal ⇒ reservation refunded exactly once, order REJECTED, ProviderError surfaced', async () => {
  const svc = firstDemoService();
  const user = createUser('failorder@test.dev', 500000);
  await assert.rejects(
    placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/fail-me', quantity: svc.min }),
    (e) => e instanceof ProviderError
  );
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 500000, 'a refused order must end with the balance restored');
  const row = db.prepare("SELECT status FROM orders WHERE link LIKE '%fail-me%'").get();
  assert.strictEqual(row.status, 'REJECTED', 'the refused order is recorded as REJECTED, never as accepted');
  const ledger = db.prepare("SELECT COALESCE(SUM(amount_inr),0) s, COUNT(*) n FROM transactions WHERE user_id=?").get(user.id);
  assert.strictEqual(Number(ledger.s), 0, 'debit and refund net to zero in the ledger');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='refund'").get(user.id).c, 1,
    'exactly one refund row');
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

console.log('P4 — authentication hardening');

await t('admin login is throttled: 5 failures then 429, a correct login resets the bucket', async () => {
  const wrong = { email: ADMIN_EMAIL, password: 'not-the-admin-password' };
  for (let i = 0; i < 5; i++) {
    const r = await call(adminAuthRouter, { method: 'POST', url: '/login', body: wrong });
    assert.strictEqual(r.statusCode, 401, `attempt ${i + 1} must be rejected with 401`);
  }
  const limited = await call(adminAuthRouter, { method: 'POST', url: '/login', body: wrong });
  assert.strictEqual(limited.statusCode, 429, 'a 6th failed admin login must be throttled');
  // Buckets are per-key: an unrelated login is unaffected. (The 15-minute
  // window reset itself prunes stale records in checkRateLimit — it needs a
  // real 15-minute wait, so it is verified by source inspection only.)
  const other = await call(adminAuthRouter, {
    method: 'POST', url: '/login',
    body: { email: 'unrelated-admin@test.dev', password: 'wrong' },
  });
  assert.strictEqual(other.statusCode, 403, 'an unrelated login bucket must be unaffected (403, not 429)');
  const ok = await call(adminAuthRouter, {
    method: 'POST', url: '/login',
    body: { email: ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD_1 },
  });
  assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.user.role, 'admin');
  // The successful login RESET the bucket: the very next wrong
  // attempt is counted from zero again (401 — not an instant 429).
  const reset = await call(adminAuthRouter, { method: 'POST', url: '/login', body: wrong });
  assert.strictEqual(reset.statusCode, 401, 'a correct login must reset the throttle bucket');
});

await t('admin login throttle buckets are per IP: another socket address is unaffected', async () => {
  const wrong = { email: ADMIN_EMAIL, password: 'not-the-admin-password' };
  // Exhaust the bucket for ONE socket address only.
  for (let i = 0; i < 5; i++) {
    const r = await call(adminAuthRouter, { method: 'POST', url: '/login', body: wrong, remoteAddress: '10.9.8.7' });
    assert.strictEqual(r.statusCode, 401, `attempt ${i + 1} from IP-A must be rejected with 401`);
  }
  const blocked = await call(adminAuthRouter, { method: 'POST', url: '/login', body: wrong, remoteAddress: '10.9.8.7' });
  assert.strictEqual(blocked.statusCode, 429, 'the exhausted IP bucket must throttle a 6th failure');
  // The same admin email from a DIFFERENT address has an independent bucket.
  const other = await call(adminAuthRouter, {
    method: 'POST', url: '/login',
    body: { email: ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD_1 },
    remoteAddress: '10.9.8.8',
  });
  assert.strictEqual(other.statusCode, 200, 'a different socket address must have an independent throttle bucket');
  assert.strictEqual(other.body.user.role, 'admin');
});

await t('rotating X-Forwarded-For cannot bypass the client login throttle', async () => {
  const body = { email: 'xff-spray@test.dev', password: 'wrong' };
  for (let i = 0; i < 5; i++) {
    const r = await call(clientAuthRouter, {
      method: 'POST', url: '/login', body,
      headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
    });
    assert.strictEqual(r.statusCode, 401, `spoofed attempt ${i + 1} must still be recorded`);
  }
  const r = await call(clientAuthRouter, {
    method: 'POST', url: '/login', body,
    headers: { 'x-forwarded-for': '10.0.0.99' },
  });
  assert.strictEqual(r.statusCode, 429, 'the throttle key must ignore X-Forwarded-For');
});

await t('order history survives a detached service (LEFT JOIN — history is never lost)', async () => {
  const svc = firstDemoService();
  const user = createUser('orphan@test.dev', 500000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/orphan', quantity: svc.min });
  // Simulate the legacy demo-provider cleanup: the service row is gone.
  db.prepare('UPDATE orders SET service_id=NULL WHERE id=?').run(order.id);
  const history = userOrders(db, user.id);
  const row = history.find((o) => o.id === order.id);
  assert.ok(row, 'a detached order must remain in the user history');
  assert.strictEqual(row.order_ref, order.order_ref);
  assert.strictEqual(row.price_inr, order.price_inr);
  const single = orderWithService(db, order.id);
  assert.ok(single && single.id === order.id, 'order detail must still resolve');
});

await t('status ticker syncs a detached order (service deleted) — never stuck PENDING forever', async () => {
  const svc = firstDemoService();
  const user = createUser('detached-sync@test.dev', 500000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/detached-sync', quantity: svc.min });
  assert.strictEqual(order.status, 'PENDING');
  // Simulate the service row being deleted AFTER the order was placed.
  // This mirrors the production cleanup path (cleanupDemoProviders):
  // order history is detached FIRST — service_id=NULL is the schema's
  // documented "service deleted, history preserved" representation
  // (schema.sql, orders.service_id) — and the service row is deleted
  // only once no order references it. A bare DELETE would violate the
  // orders.service_id foreign key (PRAGMA foreign_keys=ON), and a
  // dangling id is not a representable state — the old
  // `UPDATE … SET service_id=999999` crashed with
  // "FOREIGN KEY constraint failed" for exactly that reason.
  db.prepare('UPDATE orders SET service_id=NULL WHERE service_id=?').run(svc.id);
  db.prepare('DELETE FROM services WHERE id=?').run(svc.id);
  // DEMO_SPEED=1000 fast-forwards the lifecycle well past completion.
  await new Promise((res) => setTimeout(res, 1500));
  await syncOrderStatuses();
  const done = db.prepare('SELECT status, service_id, start_count, remains, quantity FROM orders WHERE id=?').get(order.id);
  assert.strictEqual(done.service_id, null, 'the order must survive the service deletion, detached (history preserved)');
  assert.notStrictEqual(done.status, 'PENDING', 'a detached order must still be synced (the status query must not JOIN services)');
  assert.ok(['COMPLETED', 'PARTIAL', 'IN_PROGRESS'].includes(done.status), `unexpected status ${done.status}`);
  if (done.status === 'COMPLETED') {
    assert.strictEqual(done.start_count, done.quantity, 'a completed detached order must show full start_count');
    assert.strictEqual(done.remains, 0, 'a completed detached order must show nothing remaining');
  }
});

// ---------------------------------------------------------------------------
console.log('P5 — zero-balance / mispriced order protection (incident fix)');

await t('SMM_TEST demo client retains its explicit test funding (production seeding is zero-balance)', () => {
  const demo = db.prepare("SELECT wallet_balance FROM users WHERE email='demo@instasmm.store'").get();
  assert.strictEqual(demo.wallet_balance, 50000, 'the isolated test fixture keeps its explicit funding');
});

await t('zero-priced service is rejected: BAD_PRICE before any provider call, no debit, no order, no ledger', async () => {
  const now = Date.now();
  const prov = db.prepare("SELECT id FROM providers WHERE adapter='demo'").get();
  const catId = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const svcId = Number(db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, description, speed_hint,
       type, min, max, provider_rate, admin_rate, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`
  ).run(catId, prov.id, 'zero-priced-svc', 'Zero Priced Service', null, null, 'Default', 10, 1000, 0, 0, 0, 0, now).lastInsertRowid);
  const user = createUser('zeroprice@test.dev', 500000);
  const provBefore = db.prepare('SELECT last_success_at, last_error FROM providers WHERE id=?').get(prov.id);
  await assert.rejects(
    placeOrder({ user, serviceId: svcId, link: 'https://instagram.com/zero-price', quantity: 10 }),
    (e) => e.code === 'BAD_PRICE'
  );
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 500000, 'a zero-priced order must never debit anything');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 0, 'no order row may exist');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(user.id).c, 0, 'no ledger row may exist');
  const provAfter = db.prepare('SELECT last_success_at, last_error FROM providers WHERE id=?').get(prov.id);
  assert.strictEqual(provAfter.last_success_at, provBefore.last_success_at, 'the provider must never have been called');
  assert.strictEqual(provAfter.last_error, provBefore.last_error, 'the provider must never have been called');
});

await t('negative selling rate cannot create money: BAD_PRICE, wallet unchanged', async () => {
  const now = Date.now();
  const prov = db.prepare("SELECT id FROM providers WHERE adapter='demo'").get();
  const catId = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const svcId = Number(db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate,
       type, min, max, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
  ).run(catId, prov.id, 'negative-rate-svc', 'Negative Rate Service', 10, -500, 'Default', 10, 1000, 0, 0, now).lastInsertRowid);
  const user = createUser('negrate@test.dev', 100000);
  await assert.rejects(
    placeOrder({ user, serviceId: svcId, link: 'https://instagram.com/neg-rate', quantity: 10 }),
    (e) => e.code === 'BAD_PRICE'
  );
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(after.wallet_balance, 100000, 'a negative price must never credit the wallet');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(user.id).c, 0);
});

await t('admin API rejects non-positive rates and min < 1 on service create and edit', async () => {
  // A FRESH session is required here: the P4 login-throttle tests
  // perform a REAL admin login, and startSession() deletes ALL
  // existing sessions for the user — the fixture session no
  // longer authenticates (the harness discards the new cookie).
  const cookies = makeSession(adminUser.id);
  const demoProv = db.prepare("SELECT id FROM providers WHERE adapter='demo'").get();
  const catId = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const create = (body) => call(adminServicesRouter, { method: 'POST', url: '/', body: { ...body, provider_id: demoProv.id, category_id: catId }, cookies });
  const r0 = await create({ name: 'Bad Free', provider_rate: 0 });
  assert.strictEqual(r0.statusCode, 400, 'provider_rate 0 must be rejected on create');
  const rN = await create({ name: 'Bad Neg', provider_rate: -5 });
  assert.strictEqual(rN.statusCode, 400, 'a negative provider_rate must be rejected on create');
  const rMin = await create({ name: 'Bad Min', provider_rate: 10, min: 0 });
  assert.strictEqual(rMin.statusCode, 400, 'min 0 must be rejected on create');
  // a VALID service, then invalid edits — the stored pricing must survive
  const ok = await create({ name: 'Editable Service', provider_rate: 10, min: 10, max: 1000 });
  assert.strictEqual(ok.statusCode, 201, JSON.stringify(ok.body));
  const svcId = ok.body.id;
  const e0 = await call(adminServicesRouter, { method: 'PATCH', url: `/${svcId}`, body: { provider_rate: 0 }, cookies });
  assert.strictEqual(e0.statusCode, 400, 'provider_rate 0 must be rejected on edit');
  const eN = await call(adminServicesRouter, { method: 'PATCH', url: `/${svcId}`, body: { admin_rate: -100 }, cookies });
  assert.strictEqual(eN.statusCode, 400, 'a negative admin_rate override must be rejected on edit');
  const eMin = await call(adminServicesRouter, { method: 'PATCH', url: `/${svcId}`, body: { min: 0 }, cookies });
  assert.strictEqual(eMin.statusCode, 400, 'min 0 must be rejected on edit');
  const stored = db.prepare('SELECT provider_rate, admin_rate, min FROM services WHERE id=?').get(svcId);
  assert.strictEqual(stored.provider_rate, 10, 'a rejected edit must not alter the stored rate');
  assert.ok(stored.admin_rate > 0 && stored.min === 10, 'a rejected edit must not alter stored pricing');
});

await t('an unfunded order is refused BEFORE the supplier is called (no orphan can be created)', async () => {
  // Reservation-first: the conditional debit runs before the supplier call, so a
  // balance that is gone at write time never reaches the supplier at all.
  let supplierCalls = 0;
  registerProviderAdapter('boom', () => ({
    async placeOrder() { supplierCalls++; return { id: 'BOOM-UPSTREAM-1', status: 'PENDING' }; },
    async cancel() { throw new Error('supplier cancel endpoint unreachable'); },
  }));
  const now = Date.now();
  const boomProvId = Number(db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, balance, currency, markup_type, markup_value, created_at, updated_at)
     VALUES ('Boom Provider','boom','https://boom.test','k',1,100000,'USD','percent',25,?,?)`
  ).run(now, now).lastInsertRowid);
  const catId = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  const svcId = Number(db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate,
       type, min, max, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
  ).run(catId, boomProvId, 'boom-svc', 'Boom Service', 10, 12.5, 'Default', 10, 1000, 0, 0, now).lastInsertRowid);
  // Live balance is ZERO, but the session snapshot claims the exact
  // order price — the pre-check passes, the provider accepts, and
  // the atomic conditional debit fails inside the transaction.
  const user = createUser('boom@test.dev', 0);
  const quote = quoteOrder({ serviceId: svcId, quantity: 10, couponCode: null, noProfit: false });
  const snapshot = { ...user, wallet_balance: quote.final };
  await assert.rejects(
    placeOrder({ user: snapshot, serviceId: svcId, link: 'https://instagram.com/boom', quantity: 10 }),
    (e) => e instanceof InsufficientBalanceError
  );
  assert.strictEqual(supplierCalls, 0, 'the supplier must never be asked for an order the customer cannot pay');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(user.id).c, 0);
  assert.strictEqual(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance, 0);
});

await t('ORDERS_ENABLED=0 pauses new orders with 503 ORDERS_PAUSED (reversible kill-switch)', async () => {
  const svc = firstDemoService();
  const user = createUser('paused@test.dev', 500000);
  const cookies = makeSession(user.id);
  process.env.ORDERS_ENABLED = '0';
  let r;
  try {
    r = await call(clientOrdersRouter, { method: 'POST', url: '/', body: { serviceId: svc.id, link: 'https://instagram.com/paused', quantity: svc.min }, cookies });
  } finally {
    delete process.env.ORDERS_ENABLED;
  }
  assert.strictEqual(r.statusCode, 503, `expected 503, got ${r.statusCode}`);
  assert.strictEqual(r.body.code, 'ORDERS_PAUSED');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 0);
  assert.strictEqual(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance, 500000);
  // the endpoint works again once the flag is cleared (reversible)
  const r2 = await call(clientOrdersRouter, { method: 'POST', url: '/', body: { serviceId: svc.id, link: 'https://instagram.com/resumed', quantity: svc.min }, cookies });
  assert.strictEqual(r2.statusCode, 201, JSON.stringify(r2.body));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id).c, 1);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
