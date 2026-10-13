// ---------------------------------------------------------------------------
// Session cookie flags. Runs against a throwaway SQLite file with a fake
// response object; no server, no network, no production settings.
//   run: node scripts/test-session-cookie.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'session-cookie-'));
process.env.DB_FILE = path.join(TEST_DIR, 'cookie.db');
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
delete process.env.COOKIE_SECURE;

const { getDb } = await import(path.join(ROOT, 'server', 'db.js'));
const { sessionCookieOptions, startSession } = await import(path.join(ROOT, 'server', 'middleware', 'auth.js'));
const { config } = await import(path.join(ROOT, 'server', 'config.js'));

const db = getDb();
if (db.isPg) throw new Error('test-session-cookie must run on the temporary SQLite file');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 4).join(' / ')}`); }
}

console.log('Session cookie flag tests (SQLite, fake response)');

t('default options: HttpOnly, SameSite=Strict, Secure, path /, and the configured lifetime', () => {
  const o = sessionCookieOptions(123, {});
  assert.deepStrictEqual(o, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 123, path: '/' });
});

t('COOKIE_SECURE=0 is the only way to drop the Secure flag (local plain HTTP)', () => {
  assert.strictEqual(sessionCookieOptions(1, { COOKIE_SECURE: '0' }).secure, false);
});

t('any other COOKIE_SECURE value keeps the Secure flag', () => {
  assert.strictEqual(sessionCookieOptions(1, { COOKIE_SECURE: '1' }).secure, true);
  assert.strictEqual(sessionCookieOptions(1, { COOKIE_SECURE: 'false' }).secure, true);
  assert.strictEqual(sessionCookieOptions(1, { COOKIE_SECURE: '' }).secure, true);
});

t('the process environment default is Secure when COOKIE_SECURE is unset', () => {
  assert.strictEqual(sessionCookieOptions(1).secure, true);
});

t('startSession sets the cookie with the same secure options and the configured lifetime', () => {
  db.prepare("INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at) VALUES (?,?,'client','Cookie',0,0,'active',0,?)")
    .run('cookie-test@test.dev', 'x', Date.now());
  const user = db.prepare("SELECT * FROM users WHERE email='cookie-test@test.dev'").get();
  const calls = [];
  const res = { cookie: (name, value, opts) => calls.push({ name, value, opts }) };
  startSession(res, user, '203.0.113.7');
  assert.strictEqual(calls.length, 1, 'exactly one cookie is set');
  assert.strictEqual(calls[0].name, 'instasmm_session');
  assert.ok(/^[0-9a-f]{64}$/.test(calls[0].value), 'the cookie value is a 256-bit hex token');
  assert.deepStrictEqual(calls[0].opts, sessionCookieOptions(config.sessionTtlMs, process.env));
  assert.strictEqual(calls[0].opts.secure, true);
  assert.strictEqual(calls[0].opts.httpOnly, true);
  assert.strictEqual(calls[0].opts.sameSite, 'strict');
  // Only the hash of the token is stored.
  const stored = db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(user.id).token_hash;
  assert.ok(!stored.includes(calls[0].value), 'the raw token is never stored');
});

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(TEST_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
