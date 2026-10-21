// ---------------------------------------------------------------------------
// App-level cross-process concurrency on PostgreSQL — duplicate payment references.
//   run: DATABASE_URL=postgresql://.../instasmm_refpg_test PG_TEST_CONFIRM_FRESH=1 \
//        node scripts/test-inr-payment-ref-pg-app.mjs
//
// STATUS: written for the Route B run (dependencies installed from the lockfile).
// NOT RUN in the sandbox: needs the pg module and the app's own dependencies.
//
// Why cross-process: inside one process every database call is serialized by the
// bridge, so calls cannot interleave. The real risk is two processes (or two
// app instances) verifying deposits at the same moment.
//
// Phase A (guard applied): four child processes start together and each verifies
//   a different pending deposit with the SAME bank reference. Required: exactly one
//   succeeds, the other three are refused, and the wallets receive exactly one credit.
// Phase B (PROBE, guard removed): the same race without the database guard. This
//   reports how many children credit. It does not assert: the result decides whether
//   the opt-in migration is a hard prerequisite.
//
// Refuses to run unless DATABASE_URL names a database ending in _test and
// PG_TEST_CONFIRM_FRESH=1. Applies docs/migrations/MIGRATION_inr_payment_ref_unique.sql
// only to that test database, and drops the guard only there.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const MIGRATION = path.join(ROOT, 'docs', 'migrations', 'MIGRATION_inr_payment_ref_unique.sql');
const CHILDREN = 4;
const REF = 'RACEAPP0001';

function dbNameFromUrl(u) {
  try { return decodeURIComponent(new URL(u).pathname.replace(/^\//, '')); } catch { return ''; }
}
function refuse(msg) { console.log(`REFUSED: ${msg}`); process.exit(2); }

// ---- child mode: one verification, started at a shared instant ------------
if (process.argv.includes('--child')) {
  const [depositId, startAt, adminId] = process.argv.slice(process.argv.indexOf('--child') + 1);
  const { verifyInrDeposit } = await import('../server/lib/inrDeposits.js');
  const wait = Number(startAt) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = verifyInrDeposit({ adminId: Number(adminId), depositId: Number(depositId), paymentRef: REF, note: 'app race' });
  console.log(`RESULT ${JSON.stringify(r)}`);
  process.exit(0);
}

// ---- parent mode ---------------------------------------------------------
const url = process.env.DATABASE_URL || '';
if (!/^postgres(ql)?:\/\//.test(url)) refuse('DATABASE_URL must be a postgres:// URL to a _test database');
if (!dbNameFromUrl(url).endsWith('_test')) refuse(`database '${dbNameFromUrl(url)}' must end in _test`);
if (process.env.PG_TEST_CONFIRM_FRESH !== '1') refuse('set PG_TEST_CONFIRM_FRESH=1');

const { spawnSync } = await import('node:child_process');
const psql = (sqlOrFile) => spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, ...sqlOrFile], { encoding: 'utf8' });

const { getDb } = await import('../server/db.js');
const { createInrDeposit } = await import('../server/lib/inrDeposits.js');
const db = getDb();
if (!db.isPg) refuse('this test must run against PostgreSQL');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  PASS  ${n}`); };
const bad = (n, why) => { fail++; console.log(`  FAIL  ${n} — ${why}`); };

// Fresh data for this run only. Email is unique per run so reruns do not collide.
const tag = Date.now().toString(36);
const admin = db.prepare(`INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
  VALUES (?, 'x', 'admin', 'RaceAdmin', 0, 0, 'active', 0, ?) RETURNING id`).get(`race-admin-${tag}@test.dev`, Date.now());
const users = [];
const deposits = [];
for (let i = 0; i < CHILDREN; i++) {
  const u = db.prepare(`INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
    VALUES (?, 'x', 'client', 'RaceUser', 0, 0, 'active', 0, ?) RETURNING id`).get(`race-user-${tag}-${i}@test.dev`, Date.now());
  users.push(u.id);
  const r = createInrDeposit({ userId: u.id, rupees: 100 });
  assert.ok(r.ok, `createInrDeposit failed: ${r.reason}`);
  deposits.push(r.deposit.id);
}

async function race(label, depIds) {
  const startAt = Date.now() + 2500;
  const runs = depIds.map((id) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SELF, '--child', String(id), String(startAt), String(admin.id)], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), 60_000);
    c.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').reverse().find((l) => l.startsWith('RESULT '));
      resolve(line ? JSON.parse(line.slice(7)) : { ok: false, reason: 'child-no-result', raw: out.slice(0, 300) });
    });
  }));
  return Promise.all(runs);
}

const balances = (ids) => ids.map((id) => Number(db.prepare('SELECT wallet_balance AS b FROM users WHERE id=?').get(id).b));

// ---- Phase A: guard applied -------------------------------------------------
console.log('App-level PostgreSQL duplicate-reference race');
{
  const applied = psql(['-f', MIGRATION]);
  if (applied.status !== 0) refuse(`guard could not be applied to the test database: ${applied.stderr}`);
  const results = await race('A', deposits);
  const winners = results.filter((r) => r.ok === true);
  const credited = balances(users).reduce((a, b) => a + b, 0);
  if (winners.length === 1) ok(`guard applied: exactly one of ${CHILDREN} concurrent processes verified the reference`);
  else bad('guard applied: exactly one winner', `winners=${winners.length} results=${JSON.stringify(results)}`);
  if (results.filter((r) => r.ok !== true).every((r) => ['payment-ref-already-used', 'already-terminal'].includes(r.reason))) ok('guard applied: every loser refused with payment-ref-already-used or already-terminal');
  else bad('guard applied: loser reasons', JSON.stringify(results));
  if (credited === 10000) ok('guard applied: wallets received exactly one credit (₹100)');
  else bad('guard applied: one credit', `total credited ${credited} paise (expected 10000)`);
  const again = (await race('A-repeat', [deposits[0]]))[0];
  if (again.reason === 'already-verified' && balances(users).reduce((a, b) => a + b, 0) === 10000) ok('repeated verification after the race: no further credit');
  else bad('repeated verification', JSON.stringify(again));
}

// ---- Phase B: PROBE without the guard ---------------------------------------
{
  psql(['-c', 'DROP INDEX CONCURRENTLY IF EXISTS idx_inr_deposits_verified_ref']);
  const fresh = [];
  for (let i = 0; i < CHILDREN; i++) {
    db.prepare(`UPDATE inr_deposits SET status='pending', payment_ref=NULL WHERE id=?`).run(deposits[i]);
    fresh.push(deposits[i]);
  }
  // Reset the wallet balances so the probe counts its own credits.
  for (const u of users) db.prepare('UPDATE users SET wallet_balance=0 WHERE id=?').run(u);
  const results = await race('B', fresh);
  const winners = results.filter((r) => r.ok === true).length;
  console.log(`  PROBE  without the database guard: ${winners} of ${CHILDREN} concurrent processes credited the same reference`);
  console.log(`         (informational. A result above 1 means the migration is a hard prerequisite for multi-process use.)`);
  psql(['-f', MIGRATION]); // restore the guard for the database
}

console.log(`\napp-level pg race: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
