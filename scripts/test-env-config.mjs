// ---------------------------------------------------------------------------
// Environment-configuration regression tests:
//   E1  the supplier bootstrap creates exactly ONE env-managed provider from
//       THEMAINSMMPROVIDER_* environment variables, and the provider list
//       API never exposes the API key or the full URL
//   E2  re-running the bootstrap (restart / redeploy) is idempotent — the
//       same row is updated, no duplicate provider is created
//   E3  services synced under the env-managed provider appear in the client
//       catalog / category listing (the same data the New Order page uses)
//   E4  blank environment variables are a complete no-op — a stored provider
//       is never erased, altered, or created
//   E5  valid environment configuration is authoritative for the designated
//       provider; admin-created providers (other URLs) are never touched
//   E6  an invalid (non-https) URL produces a safe configuration error,
//       creates nothing, and leaks no credential
//   E7  Apirone credentials: environment wins while set, a blank variable
//       falls back to stored settings (never erased), blank both means
//       "not configured"
//   E8  the INR gateway stays disabled (GATEWAY_CONNECTED = false): only the
//       MANUAL workflow routes are mounted (pending-claim / admin
//       verification) — no automated VCGetaway checkout, webhook, or
//       gateway API client exists
//   E9  re-syncing the same service list creates no duplicate services
//
// Usage: node scripts/test-env-config.mjs
//
// Runs against a THROWAWAY SQLite database (DB_FILE is honored at import
// time, so it is set before any server module loads). FAKE credentials only
// (unresolvable .test hosts) — the bootstrap and the sync path perform no
// network calls, so nothing here can reach a real supplier or payment API.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// --- environment BEFORE any server module is imported (config.js reads it)
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-envcfg-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'envcfg.db');
process.env.ADMIN_EMAIL_1 = 'envcfg-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'envcfg-admin-pass-123';
process.env.SESSION_SECRET = 'envcfg-session-secret';
process.env.DEMO_SPEED = '1000';

// Fake supplier + Apirone credentials. Structurally valid, pointed at
// unresolvable .test hosts; never used for a network call in this suite.
const FAKE_SUPPLIER_URL = 'https://api.fake-supplier.test/api/v2';
const FAKE_SUPPLIER_KEY = 'fake-supplier-key-0000';
const FAKE_APIRONE_ACCOUNT = 'fake-apirone-account-0000';
const FAKE_APIRONE_TRANSFER = 'fake-apirone-transfer-key-0000';
process.env.THEMAINSMMPROVIDER_API_URL = FAKE_SUPPLIER_URL;
process.env.THEMAINSMMPROVIDER_API_KEY = FAKE_SUPPLIER_KEY;
process.env.APIRONE_ACCOUNT_ID = FAKE_APIRONE_ACCOUNT;
process.env.APIRONE_TRANSFER_KEY = FAKE_APIRONE_TRANSFER;

// always clean up our own throwaway test database
process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { getDb, setSetting } = await import('../server/db.js');
const { bootstrapManagedProvider } = await import('../server/lib/managedProvider.js');
const { apironeCreds, isApironeConfigured } = await import('../server/lib/apirone.js');
const { syncProviderServices } = await import('../server/lib/providerSync.js');
const { maskedProvider } = await import('../server/lib/provider.js');
const { config } = await import('../server/config.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const clientServicesRouter = (await import('../server/routes/client.services.js')).default;

const db = getDb();

// ---------------------------------------------------------------------------
// Tiny harness (mirrors scripts/test-categories.mjs)
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

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {}, headers = {} } = {}) {
  const req = { method, url, query, body, cookies, headers, ip: '127.0.0.1', user: null };
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
     VALUES (?,?, 'client', 'EnvCfg', ?, 0, 'active', 0, ?)`
  ).run(email, hashPassword('envcfg-pass-1'), balancePaise, now);
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get('envcfg-admin@test.dev');
assert.ok(adminUser && adminUser.role === 'admin', 'admin seed missing');
const clientUser = createUser('envcfg-client@test.dev', 1000);
const clientCookies = makeSession(clientUser.id);

// A synthetic service list — the exact shape syncProviderServices consumes
// (the same function the Admin → Providers → Sync Services route calls).
const SERVICE_LIST = [
  { service: 'env-1', name: 'EnvCfg Test Service', category: 'EnvCfg Category', rate: 5, min: 10, max: 1000 },
];

function managedProviderRow() {
  return db.prepare('SELECT * FROM providers WHERE env_managed=1').get();
}
function providerCount() {
  return db.prepare('SELECT COUNT(*) c FROM providers').get().c;
}

console.log('E1/E2 — environment-managed supplier bootstrap');

await t('E1: the bootstrap creates exactly ONE env-managed provider from the environment', () => {
  const before = providerCount();
  const out = bootstrapManagedProvider();
  assert.strictEqual(out.status, 'created', JSON.stringify(out));
  const row = managedProviderRow();
  assert.ok(row, 'an env-managed provider row must exist');
  assert.strictEqual(row.api_url, FAKE_SUPPLIER_URL);
  assert.strictEqual(row.api_key, FAKE_SUPPLIER_KEY);
  assert.strictEqual(row.adapter, 'smmpost');
  assert.strictEqual(row.currency, 'USD');
  assert.strictEqual(row.markup_type, 'percent');
  assert.strictEqual(row.markup_value, 25);
  assert.strictEqual(providerCount(), before + 1, 'exactly one provider must be created');
});

await t('E1: the provider API never exposes the API key or the full URL', () => {
  const masked = maskedProvider(managedProviderRow());
  assert.strictEqual(masked.has_api_key, true, 'the masked view must flag that a key is set');
  assert.ok(!('api_key' in masked), 'api_key must never be serialized');
  assert.ok(!('api_url' in masked), 'the full api_url must never be serialized');
  assert.strictEqual(masked.api_url_masked, 'https://…', 'only an 8-character URL prefix may be shown');
});

await t('E2: re-running the bootstrap (restart / redeploy) is idempotent', () => {
  const first = managedProviderRow();
  const count = providerCount();
  const out = bootstrapManagedProvider();
  assert.strictEqual(out.status, 'updated', JSON.stringify(out));
  assert.strictEqual(out.id, first.id, 'the SAME row must be updated — no duplicate');
  assert.strictEqual(providerCount(), count, 'no additional provider row may appear');
  const row = managedProviderRow();
  assert.strictEqual(row.api_url, FAKE_SUPPLIER_URL);
  assert.strictEqual(row.api_key, FAKE_SUPPLIER_KEY);
});

console.log('E3 — catalog / category availability (the New Order data path)');

await t('E3: services synced under the env-managed provider appear in the client catalog', async () => {
  const provider = managedProviderRow();
  const out = syncProviderServices(db, { provider, list: SERVICE_LIST, globalMarkup: { type: 'percent', value: 25 } });
  assert.strictEqual(out.added, 1, 'the synthetic service must be synced');
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const cat = r.body.categories.find((c) => c.name === 'EnvCfg Category');
  assert.ok(cat, 'the synced category must be listed');
  const svc = cat.services.find((s) => s.name === 'EnvCfg Test Service');
  assert.ok(svc, 'the synced service must be listed under its category');
  assert.strictEqual(svc.category_id, cat.id, 'the service must carry its real category id');
  assert.ok(!('provider_rate' in svc) && !('admin_rate' in svc), 'no server-side pricing may leak');
});

console.log('E4/E5/E6 — precedence and safe failures');

await t('E4: blank environment variables are a complete no-op', () => {
  const row = managedProviderRow();
  const count = providerCount();
  const out = bootstrapManagedProvider({ apiUrl: '', apiKey: '' });
  assert.strictEqual(out.status, 'skipped', JSON.stringify(out));
  assert.strictEqual(providerCount(), count, 'nothing may be created');
  const after = db.prepare('SELECT api_url, api_key FROM providers WHERE id=?').get(row.id);
  assert.strictEqual(after.api_url, FAKE_SUPPLIER_URL, 'the stored URL must be untouched');
  assert.strictEqual(after.api_key, FAKE_SUPPLIER_KEY, 'the stored key must be untouched');
});

await t('E5: valid environment configuration is authoritative; other providers are never touched', () => {
  // An admin-created provider on a DIFFERENT url (direct row, as the admin
  // panel would create it).
  const now = Date.now();
  const adminId = Number(db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, currency, markup_type, markup_value, created_at, updated_at)
     VALUES (?, 'smmpost', ?, ?, 1, 'USD', 'percent', 25, ?, ?)`
  ).run('Admin Provider', 'https://api.other-supplier.test/api/v2', 'other-admin-key', now, now).lastInsertRowid);

  // Rotate the environment credentials (as an operator would on Render).
  const out = bootstrapManagedProvider({ apiUrl: FAKE_SUPPLIER_URL, apiKey: 'fake-supplier-key-1111' });
  assert.strictEqual(out.status, 'updated', JSON.stringify(out));

  const managed = managedProviderRow();
  assert.strictEqual(managed.api_key, 'fake-supplier-key-1111', 'the designated row must follow the environment');

  const other = db.prepare('SELECT api_url, api_key, env_managed FROM providers WHERE id=?').get(adminId);
  assert.strictEqual(other.api_url, 'https://api.other-supplier.test/api/v2');
  assert.strictEqual(other.api_key, 'other-admin-key', 'an admin-created provider must never be touched');
  assert.strictEqual(other.env_managed, 0, 'an admin-created provider must never be flagged env-managed');
});

await t('E6: an invalid URL fails safely — nothing created, no credential leaked', () => {
  const count = providerCount();
  const out = bootstrapManagedProvider({ apiUrl: 'not-a-url', apiKey: 'fake-supplier-key-2222' });
  assert.strictEqual(out.status, 'error', JSON.stringify(out));
  assert.ok(out.message.length > 0);
  assert.ok(!out.message.includes('fake-supplier-key-2222'), 'the error must never contain the credential');
  assert.ok(!out.message.includes('not-a-url'), 'the error must never echo the invalid value back');
  // Plain http is rejected too — only https is allowed.
  const insecure = bootstrapManagedProvider({ apiUrl: 'http://insecure.example.com/api', apiKey: 'x' });
  assert.strictEqual(insecure.status, 'error', 'a non-https URL must be rejected');
  assert.strictEqual(providerCount(), count, 'nothing may be created');
  assert.strictEqual(managedProviderRow().api_key, 'fake-supplier-key-1111', 'the stored provider must be untouched');
});

console.log('E7 — Apirone environment precedence');

await t('E7: Apirone credentials load from the environment and never erase stored settings', () => {
  // Environment set → environment wins (even when settings-table values exist).
  setSetting('apirone_account_id', 'stored-account-0000');
  setSetting('apirone_transfer_key', 'stored-transfer-0000');
  let creds = apironeCreds();
  assert.strictEqual(creds.account_id, FAKE_APIRONE_ACCOUNT, 'the environment value must win');
  assert.strictEqual(creds.transfer_key, FAKE_APIRONE_TRANSFER);
  assert.ok(isApironeConfigured(), 'non-blank credentials must count as configured');

  // Blank environment → stored settings are the fallback (never erased).
  const savedAccount = process.env.APIRONE_ACCOUNT_ID;
  const savedTransfer = process.env.APIRONE_TRANSFER_KEY;
  process.env.APIRONE_ACCOUNT_ID = '';
  process.env.APIRONE_TRANSFER_KEY = '';
  creds = apironeCreds();
  assert.strictEqual(creds.account_id, 'stored-account-0000', 'a blank variable must fall back to the stored value');
  assert.strictEqual(creds.transfer_key, 'stored-transfer-0000');
  assert.strictEqual(
    db.prepare("SELECT value FROM settings WHERE key='apirone_account_id'").get().value,
    'stored-account-0000', 'the stored setting itself must never be rewritten'
  );

  // Blank both → not configured (the production no-fake-invoice gate).
  setSetting('apirone_account_id', '');
  setSetting('apirone_transfer_key', '');
  creds = apironeCreds();
  assert.strictEqual(creds.account_id, '');
  assert.strictEqual(creds.transfer_key, '');
  assert.strictEqual(isApironeConfigured(), false, 'blank credentials must mean NOT configured');

  // Restore the environment for any later checks.
  process.env.APIRONE_ACCOUNT_ID = savedAccount;
  process.env.APIRONE_TRANSFER_KEY = savedTransfer;
});

console.log('E8 — INR gateway stays disabled (manual workflow only)');

await t('E8: GATEWAY_CONNECTED = false; only the manual INR workflow is mounted (no automated VCGetaway integration)', () => {
  // The automated deposit page stays disconnected.
  const vcSource = readFileSync(path.join(config.rootDir, 'client', 'src', 'pages', 'client', 'VcDeposit.jsx'), 'utf8');
  assert.ok(vcSource.includes('const GATEWAY_CONNECTED = false;'),
    'GATEWAY_CONNECTED must remain false');
  assert.ok(vcSource.includes('if (!GATEWAY_CONNECTED || !valid) return;'),
    'the pay action must stay guarded by GATEWAY_CONNECTED');

  const indexSource = readFileSync(path.join(config.rootDir, 'server', 'index.js'), 'utf8');
  const webhookSource = readFileSync(path.join(config.rootDir, 'server', 'routes', 'webhooks.js'), 'utf8');

  // The intended MANUAL workflow routes ARE mounted (allowed, expected):
  // pending-claim on the client side, admin verification on the admin side.
  assert.ok(indexSource.includes("app.use('/api/deposits/inr'"),
    'the manual client INR deposit router must be mounted');
  assert.ok(indexSource.includes("app.use('/api/admin/deposits/inr'"),
    'the manual admin INR verification router must be mounted');

  // No AUTOMATED gateway integration: no VCGetaway/INR-gateway route or
  // webhook mount anywhere, and the sample site's /api/notify-payment
  // endpoint is not mounted on our side either.
  for (const [name, src] of [['server/index.js', indexSource], ['server/routes/webhooks.js', webhookSource]]) {
    assert.ok(!/app\.use\(\s*['"][^'"]*(vcgetaway|inr[-_.]?gateway)/i.test(src),
      `${name} must not mount an automated VCGetaway/INR-gateway route`);
    assert.ok(!/webhooks?\/(vcgetaway|inr[-_.]?gateway)/i.test(src),
      `${name} must not mount a VCGetaway/INR-gateway webhook`);
    assert.ok(!/notify-payment/.test(src),
      `${name} must not mount the sample site's /api/notify-payment endpoint`);
  }
  // webhooks.js contains no gateway integration at all.
  assert.ok(!/vcgetaway|vc_getaway|inr.?gateway/i.test(webhookSource),
    'server/routes/webhooks.js must contain no VCGetaway/INR-gateway integration');

  // No automated gateway client module (checkout / notify / status API).
  const libFiles = readdirSync(path.join(config.rootDir, 'server', 'lib'));
  const providerFiles = readdirSync(path.join(config.rootDir, 'server', 'lib', 'providers'));
  const gatewayModules = [...libFiles, ...providerFiles].filter((f) => /vcgetaway|inr[-_.]?gateway/i.test(f));
  assert.deepStrictEqual(gatewayModules, [], 'no automated gateway client module may exist');

  // The manual workflow performs NO network calls of its own.
  const manualFiles = [['lib', 'inrDeposits.js'], ['routes', 'client.inrDeposits.js'], ['routes', 'admin.inrDeposits.js']];
  for (const [dir, f] of manualFiles) {
    const src = readFileSync(path.join(config.rootDir, 'server', dir, f), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} must not make network calls`);
  }
});

console.log('E9 — idempotent synchronization');

await t('E9: re-syncing the same service list creates no duplicate services', () => {
  const provider = managedProviderRow();
  const before = db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(provider.id).c;
  syncProviderServices(db, { provider, list: SERVICE_LIST, globalMarkup: { type: 'percent', value: 25 } });
  syncProviderServices(db, { provider, list: SERVICE_LIST, globalMarkup: { type: 'percent', value: 25 } });
  const after = db.prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(provider.id).c;
  assert.strictEqual(after, before, 'repeated syncs must be idempotent (no duplicate services)');
});

// ---------------------------------------------------------------------------
console.log(`\nenv-config: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
