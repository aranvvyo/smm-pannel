// ---------------------------------------------------------------------------
// Restart-persistence verification — the one provider-setting guarantee that
// no other automated test covers: credentials stored in the providers table
// must survive a REAL server stop + restart, and must never appear in any
// API response (only has_api_key + a masked URL may be returned).
//
// Usage: node scripts/test-restart-persistence.mjs
//
// Safety: uses ONLY a throwaway SQLite database in /tmp (DB_FILE), a fake
// test provider with a fake API key, a test admin account built from env,
// and an ephemeral port (3123). It starts its own server process, stops it
// (real process exit), starts it again against the same DB file, and removes
// every artifact it created afterwards. It never touches data/instasmm.db,
// real providers, real credentials, or the INR/payment scaffolding.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '3123';
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = path.join(tmpdir(), `instasmm-restart-test-${process.pid}.db`);
const ADMIN_EMAIL = 'restart-admin@test.dev';
const ADMIN_PASSWORD = 'restart-verify-pass-123';
const PROVIDER_NAME = 'Restart Test Provider';
const PROVIDER_URL = 'https://api.restart-test.example/smm';
const PROVIDER_KEY = 'sk-restart-test-fake-000111222333'; // dummy — never a real key

const childEnv = {
  ...process.env,
  SMM_TEST: '1',
  DB_FILE: TEST_DB,
  ADMIN_EMAIL_1: ADMIN_EMAIL,
  ADMIN_PASSWORD_1: ADMIN_PASSWORD,
  SESSION_SECRET: 'restart-test-session-secret',
  PORT,
  DEMO_SPEED: '1000',
};

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

function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errBuf = [];
  child.stderr.on('data', (d) => { errBuf.push(String(d)); if (errBuf.length > 400) errBuf.shift(); });
  child.stdout.on('data', () => { /* drain so the pipe never blocks */ });
  return { child, errBuf };
}

async function waitReady(child, errBuf) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${errBuf.join('').slice(-2000)}`);
    }
    try {
      const res = await fetch(`${BASE}/api/landing/stats`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error('server did not become ready in 20s:\n' + errBuf.join('').slice(-2000));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function stopServer(srv) {
  return new Promise((resolve) => {
    const { child } = srv;
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.kill('SIGTERM'); // only the test server we started
  });
}

async function api(method, pathname, { body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { /* non-JSON */ }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const session = setCookies.map((c) => c.split(';')[0])
    .find((c) => c.startsWith('instasmm_session='));
  return { status: res.status, data, cookie: session };
}

async function adminLogin() {
  const r = await api('POST', '/api/admin/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  assert.strictEqual(r.status, 200, 'admin login failed: ' + JSON.stringify(r.data));
  assert.ok(r.cookie && r.cookie.startsWith('instasmm_session='), 'no instasmm_session cookie was set');
  return r.cookie;
}

// The response may contain has_api_key + api_url_masked — never the key,
// never the URL, never any other secret field.
function assertProviderMasked(payload, label) {
  const providers = payload.providers;
  assert.ok(Array.isArray(providers) && providers.length >= 1, `${label}: no providers returned`);
  const p = providers.find((x) => x.name === PROVIDER_NAME);
  assert.ok(p, `${label}: test provider missing from the list`);
  assert.strictEqual(p.has_api_key, true, `${label}: has_api_key must be true`);
  assert.ok(typeof p.api_url_masked === 'string' && p.api_url_masked.length > 0,
    `${label}: api_url_masked must be present`);
  assert.ok(!('api_key' in p), `${label}: response must not contain an api_key field`);
  assert.ok(!('api_url' in p), `${label}: response must not contain an api_url field`);
  const raw = JSON.stringify(providers);
  assert.ok(!raw.includes(PROVIDER_KEY), `${label}: the API key leaked into the response`);
  assert.ok(!raw.includes(PROVIDER_URL), `${label}: the API URL leaked into the response`);
}

console.log('Restart-persistence verification (throwaway /tmp DB, fake test provider)');
console.log(`  test database: ${TEST_DB}`);

let srv = null;
try {
  // ---- BOOT 1: create the test provider -------------------------------
  srv = startServer();
  await waitReady(srv.child, srv.errBuf);
  const cookie1 = await adminLogin();

  await t('test provider created via POST /api/admin/providers (create response is masked)', async () => {
    const r = await api('POST', '/api/admin/providers', {
      cookie: cookie1,
      body: {
        name: PROVIDER_NAME, adapter: 'smmpost',
        api_url: PROVIDER_URL, api_key: PROVIDER_KEY,
        active: 1, currency: 'USD', markup_type: 'percent', markup_value: 20,
      },
    });
    assert.strictEqual(r.status, 201, 'create failed: ' + JSON.stringify(r.data));
    assert.strictEqual(r.data.has_api_key, true, 'create response must report has_api_key=true');
    assert.ok(!('api_key' in r.data) && !('api_url' in r.data), 'create response leaked secret fields');
  });

  await t('GET /api/admin/providers returns has_api_key + masked URL and NO secrets (boot 1)', async () => {
    const r = await api('GET', '/api/admin/providers', { cookie: cookie1 });
    assert.strictEqual(r.status, 200, 'list failed: ' + JSON.stringify(r.data));
    assertProviderMasked(r.data, 'boot 1');
  });

  // ---- REAL STOP --------------------------------------------------------
  const code = await stopServer(srv);
  srv = null;
  console.log(`  (test server stopped — real process exit, code ${code})`);

  // ---- BOOT 2: same DB file, credentials must survive ------------------
  srv = startServer();
  await waitReady(srv.child, srv.errBuf);
  const cookie2 = await adminLogin();

  await t('provider + credentials persist across a real server stop and restart', async () => {
    const r = await api('GET', '/api/admin/providers', { cookie: cookie2 });
    assert.strictEqual(r.status, 200, 'list after restart failed: ' + JSON.stringify(r.data));
    assertProviderMasked(r.data, 'boot 2 (after restart)');
  });

  await t('the stored provider row still holds the exact test key/URL in the DB file', async () => {
    const fresh = new DatabaseSync(TEST_DB);
    try {
      const row = fresh.prepare('SELECT api_key, api_url, active FROM providers WHERE name=?').get(PROVIDER_NAME);
      assert.ok(row, 'provider row missing after restart');
      assert.strictEqual(row.api_key, PROVIDER_KEY, 'stored API key changed across restart');
      assert.strictEqual(row.api_url, PROVIDER_URL, 'stored API URL changed across restart');
      assert.strictEqual(row.active, 1, 'provider must still be active after restart');
    } finally {
      fresh.close();
    }
  });

  await stopServer(srv);
  srv = null;
} finally {
  // Never leave the test server running; clean up artifacts ONLY after it stopped.
  if (srv && srv.child.exitCode === null) srv.child.kill('SIGKILL');
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
