// ---------------------------------------------------------------------------
// Admin withdrawal execution tests. MOCKED provider only: no network, no real
// withdrawals, no broadcasts. Temporary SQLite file only.
//   run: node scripts/test-withdrawal-execution.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `withdrawal-exec-test-${process.pid}.db`);
const SECRET = 'TEST-ONLY-TRANSFER-KEY-7f3a';
process.env.DB_FILE = DB_FILE;
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';

let unexpectedFetch = 0;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const { executeWithdrawal } = await import(path.join(ROOT, 'server', 'lib', 'withdrawalExecution.js'));
const db = dbm.getDb();
if (db.isPg) throw new Error('test-withdrawal-execution must run on the temporary SQLite file');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}

// ---- fixtures -------------------------------------------------------------
db.prepare('INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, created_at) VALUES (?,?,?,?,?,?,?)')
  .run('wd-exec@test.dev', 'x', 'admin', 'WD Exec', 0, 0, Date.now());
const adminId = db.prepare("SELECT id FROM users WHERE email='wd-exec@test.dev'").get().id;

const ADDR = 'LTC-TEST-ADDRESS-0001';
let seq = 0;
const baseRow = (over = {}) => ({
  adminId, currency: 'LTC', currencyCode: 'ltc', address: ADDR, mode: 'amount',
  amountMinor: 123_456_789, amountUsd: 0, rate: 90, fee: 'normal', subtractFee: true, ...over,
});
const newKey = () => `test-key-${++seq}-${process.pid}`;
const rowFor = (key) => db.prepare('SELECT * FROM withdrawals WHERE idempotency_key=?').get(key);
const countSent = () => db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE admin_id=? AND status='sent'").get(adminId).n;

// A mock provider. Each test sets `behaviour` and reads `calls`.
let calls = 0;
let behaviour = null;
const provider = () => async () => {
  calls++;
  if (typeof behaviour === 'function') return behaviour();
  return { ok: true, ref: 'gw-ref-1', txHash: 'hash-real-1' };
};
const rejected = (msg = 'HTTP 422') => Object.assign(new Error(msg), { kind: 'rejected' });
const ambiguous = (msg = 'socket hang up') => Object.assign(new Error(msg), { kind: 'unknown' });
const plainTimeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

const run = (key, over = {}, submit = provider(), now = Date.now()) =>
  executeWithdrawal({ db, key, submit, redact: (s) => String(s).split(SECRET).join('[redacted]'), row: baseRow(over), now });

console.log('Admin withdrawal execution tests (mocked provider)');

await t('a successful transfer is recorded as sent with the gateway reference and tx hash, once', async () => {
  calls = 0; behaviour = null;
  const key = newKey();
  const out = await run(key);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls, 1);
  const r = rowFor(key);
  assert.strictEqual(r.status, 'sent');
  assert.strictEqual(r.transfer_ref, 'gw-ref-1');
  assert.strictEqual(r.tx_hash, 'hash-real-1');
  assert.ok(r.executed_at, 'executed_at set');
});

await t('an identical retry after success is blocked and never reaches the provider', async () => {
  calls = 0;
  const key = newKey();
  await run(key, { amountMinor: 555_000_001 });
  const again = await run(key, { amountMinor: 555_000_001 }, provider());
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'DUPLICATE');
  assert.strictEqual(calls, 1, 'provider called exactly once across both attempts');
});

await t('the same transfer under a NEW key within the window is blocked by parameters (double-click with a fresh key)', async () => {
  calls = 0;
  const amt = 777_000_003;
  await run(newKey(), { amountMinor: amt });
  const second = await run(newKey(), { amountMinor: amt });
  assert.strictEqual(second.code, 'DUPLICATE');
  assert.strictEqual(calls, 1);
});

await t('a legitimate repeat payout of the same amount after the window is allowed', async () => {
  calls = 0;
  const amt = 888_000_005;
  const old = newKey();
  await run(old, { amountMinor: amt });
  // Age the first send beyond the 2-minute window.
  db.prepare('UPDATE withdrawals SET created_at=? WHERE idempotency_key=?').run(Date.now() - 10 * 60_000, old);
  const next = await run(newKey(), { amountMinor: amt });
  assert.strictEqual(next.ok, true, 'a genuinely new payout after the window must not be blocked');
  assert.strictEqual(calls, 2);
});

await t('CONCURRENT identical requests reach the provider exactly once (reservation before the await)', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, ref: 'gw-ref-c', txHash: null }), 40));
  const outs = await Promise.all(Array.from({ length: 6 }, () => run(key, { amountMinor: 999_000_007 })));
  behaviour = null;
  assert.strictEqual(calls, 1, `provider was called ${calls} times`);
  assert.strictEqual(outs.filter((o) => o.ok).length, 1);
  assert.ok(outs.filter((o) => !o.ok).every((o) => o.code === 'DUPLICATE'));
});

await t('a definite gateway rejection (4xx) is failed, says nothing was sent, and frees the key for a corrected retry', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => { throw rejected('HTTP 422'); };
  const out = await run(key, { amountMinor: 111_000_011 });
  behaviour = null;
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'WITHDRAWAL_FAILED');
  assert.match(out.message, /Nothing was sent/);
  assert.strictEqual(rowFor(key), undefined, 'the original key is retired');
  const failed = db.prepare("SELECT status FROM withdrawals WHERE idempotency_key LIKE ?").get(`${key}#failed#%`);
  assert.strictEqual(failed.status, 'failed');
  const retry = await run(key, { amountMinor: 111_000_011 });
  assert.strictEqual(retry.ok, true, 'a corrected retry after a definite rejection is allowed');
  assert.strictEqual(calls, 2);
});

await t('an ambiguous timeout is recorded as UNKNOWN, never as "nothing was sent", and blocks every retry', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => { throw plainTimeout(); };
  const out = await run(key, { amountMinor: 222_000_013 });
  behaviour = null;
  assert.strictEqual(out.code, 'WITHDRAWAL_UNKNOWN');
  assert.ok(!/nothing was sent/i.test(out.message), 'must not claim nothing was sent');
  assert.match(out.message, /Do NOT retry/);
  assert.strictEqual(rowFor(key).status, 'unknown');
  // Same key and identical parameters under a fresh key must both be refused.
  const sameKey = await run(key, { amountMinor: 222_000_013 });
  const freshKey = await run(newKey(), { amountMinor: 222_000_013 });
  assert.strictEqual(sameKey.code, 'DUPLICATE');
  assert.strictEqual(freshKey.code, 'DUPLICATE');
  assert.strictEqual(calls, 1, 'no retry reached the provider');
});

await t('a 5xx gateway answer is UNKNOWN (the transfer may have been broadcast)', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => { throw ambiguous('HTTP 503'); };
  const out = await run(key, { amountMinor: 333_000_017 });
  behaviour = null;
  assert.strictEqual(out.code, 'WITHDRAWAL_UNKNOWN');
  assert.strictEqual(rowFor(key).status, 'unknown');
});

await t('an accepted transfer with NO gateway reference is UNKNOWN, not failed', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => { throw Object.assign(new Error('Gateway accepted the transfer but returned no reference.'), { kind: 'unknown' }); };
  const out = await run(key, { amountMinor: 444_000_019 });
  behaviour = null;
  assert.strictEqual(out.code, 'WITHDRAWAL_UNKNOWN');
  assert.strictEqual(rowFor(key).status, 'unknown');
});

await t('a provider error that echoes the transfer key is redacted before it is stored', async () => {
  calls = 0;
  const key = newKey();
  behaviour = () => { throw rejected(`bad request with token ${SECRET}`); };
  await run(key, { amountMinor: 555_000_023 });
  behaviour = null;
  const stored = db.prepare('SELECT error FROM withdrawals WHERE idempotency_key LIKE ?').get(`${key}#failed#%`);
  assert.ok(stored.error.includes('[redacted]'));
  assert.ok(!stored.error.includes(SECRET), 'secret persisted');
});

await t('if the success record cannot be saved, the result is RECORD_FAILED (never "not sent") and retries stay blocked', async () => {
  calls = 0;
  const key = newKey();
  // A db wrapper that fails only the "sent" update, simulating a write error after a real send.
  const flaky = {
    prepare: (sql) => {
      if (sql.startsWith("UPDATE withdrawals SET status='sent'")) {
        return { run: () => { throw new Error('disk I/O error'); } };
      }
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
  };
  const out = await executeWithdrawal({ db: flaky, key, submit: provider(), redact: (s) => s, row: baseRow({ amountMinor: 666_000_029 }) });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'RECORD_FAILED');
  assert.strictEqual(out.http, 500);
  assert.match(out.message, /accepted this transfer/);
  assert.ok(!/nothing was sent/i.test(out.message));
  assert.strictEqual(rowFor(key).status, 'unknown');
  const retry = await run(key, { amountMinor: 666_000_029 });
  assert.strictEqual(retry.code, 'DUPLICATE');
  assert.strictEqual(calls, 1);
});

await t('a row already holding the same key is refused before any provider call (pre-check path; the UNIQUE index is the backstop)', async () => {
  calls = 0;
  const key = newKey();
  // Insert a row with this key directly, as a concurrent winner would have done.
  db.prepare(`INSERT INTO withdrawals (admin_id, currency, currency_code, address, mode, amount_minor, amount_usd, rate_inr, fee, subtract_fee, status, idempotency_key, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(adminId, 'LTC', 'ltc', 'OTHER-ADDRESS-RACE', 'amount', 1, 0, 90, 'normal', 1, key, Date.now() - 999_999_999);
  const out = await run(key, { address: 'DIFFERENT-ADDRESS-RACE', amountMinor: 777_777_031 });
  assert.strictEqual(out.code, 'DUPLICATE');
  assert.strictEqual(calls, 0);
});

await t('a stale pending reservation still blocks an identical transfer until someone resolves it', async () => {
  calls = 0;
  const amt = 888_888_037;
  const stuck = newKey();
  db.prepare(`INSERT INTO withdrawals (admin_id, currency, currency_code, address, mode, amount_minor, amount_usd, rate_inr, fee, subtract_fee, status, idempotency_key, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(adminId, 'LTC', 'ltc', ADDR, 'amount', amt, 0, 90, 'normal', 1, stuck, Date.now() - 24 * 3600_000);
  const out = await run(newKey(), { amountMinor: amt });
  assert.strictEqual(out.code, 'DUPLICATE');
  assert.strictEqual(calls, 0);
});

await t('no test reached the real network', () => {
  assert.strictEqual(unexpectedFetch, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
if (fail > 0) process.exit(1);
