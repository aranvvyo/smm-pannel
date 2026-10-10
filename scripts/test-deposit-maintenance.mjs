// ---------------------------------------------------------------------------
// Deposit maintenance + crypto notification regression tests (SQLite, throwaway
// database, real modules). Route-level checks need express and run separately.
// Usage: node scripts/test-deposit-maintenance.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-maint-'));
const DB_FILE = path.join(TEST_DIR, 'maint.db');
process.env.SMM_TEST = '1';
process.env.DB_FILE = DB_FILE;
process.env.ADMIN_EMAIL_1 = 'maint-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'maint-admin-pass-123';
process.env.SESSION_SECRET = 'maint-session-secret';
process.env.DEMO_SPEED = '1000';
process.env.DATABASE_URL = '';

const ROOT = process.cwd();
const { getDb } = await import(path.join(ROOT, 'server/db.js'));
const { hashPassword } = await import(path.join(ROOT, 'server/lib/passwords.js'));
const M = await import(path.join(ROOT, 'server/lib/depositMaintenance.js'));
const { creditDeposit } = await import(path.join(ROOT, 'server/lib/apirone.js'));
const { requireAdmin } = await import(path.join(ROOT, 'server/middleware/auth.js'));
const db = getDb();
if (db.isPg) throw new Error('must run on the throwaway SQLite file');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 4).join(' / ')}`); }
}
const user = (email, balance = 0) => {
  db.prepare(`INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
    VALUES (?,?,'client','Maint',?,0,'active',0,?)`).run(email, hashPassword('maint-pass-1'), balance, Date.now());
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
};
const invoice = (userId, amountUsdCents, status = 'pending') => {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO deposits (user_id, invoice_id, currency, amount_usd, amount_inr, status, is_simulated, paid_usd, created_at, expires_at)
    VALUES (?,?,'LTC',?,0,?,1,0,?,?)`).run(userId, `inv-${now}-${Math.random()}`, amountUsdCents, status, now, now + 86400000);
  return Number(r.lastInsertRowid);
};
const wallet = (id) => Number(db.prepare('SELECT wallet_balance w FROM users WHERE id=?').get(id).w);
const notices = (id, title) => db.prepare('SELECT body FROM notifications WHERE user_id=? AND title=? ORDER BY id').all(id, title).map((r) => r.body);

console.log('Deposit maintenance and crypto notification tests (SQLite)');

await t('defaults are explicit: INR maintenance ON, crypto maintenance OFF', () => {
  assert.strictEqual(M.getMaintenance('inr').enabled, true);
  assert.strictEqual(M.getMaintenance('crypto').enabled, false);
});

await t('INR and crypto switches are independent in both directions', () => {
  M.setMaintenance({ method: 'crypto', enabled: true, message: 'x', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
  assert.strictEqual(M.getMaintenance('inr').enabled, true, 'enabling crypto must not change INR');
  M.setMaintenance({ method: 'crypto', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
  M.setMaintenance({ method: 'inr', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('inr').version });
  assert.strictEqual(M.getMaintenance('crypto').enabled, false, 'disabling INR must not change crypto');
  assert.strictEqual(M.getMaintenance('inr').enabled, false);
  M.setMaintenance({ method: 'inr', enabled: true, message: '', actor: 'a', expectedVersion: M.getMaintenance('inr').version });
});

await t('assertDepositsOpen throws DEPOSIT_MAINTENANCE only for the paused method', () => {
  M.setMaintenance({ method: 'crypto', enabled: true, message: 'Paused for test', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
  assert.throws(() => M.assertDepositsOpen('crypto'), (e) => e.code === 'DEPOSIT_MAINTENANCE' && e.message === 'Paused for test');
  // INR is ON by default, so it must still be refused; turning it OFF lets it through.
  assert.throws(() => M.assertDepositsOpen('inr'), (e) => e.code === 'DEPOSIT_MAINTENANCE');
  M.setMaintenance({ method: 'inr', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('inr').version });
  M.assertDepositsOpen('inr');
  M.setMaintenance({ method: 'inr', enabled: true, message: '', actor: 'a', expectedVersion: M.getMaintenance('inr').version });
  M.setMaintenance({ method: 'crypto', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
});

await t('a stale save is refused and does not overwrite the newer setting', () => {
  const before = M.getMaintenance('crypto');
  const fresh = M.setMaintenance({ method: 'crypto', enabled: true, message: 'new', actor: 'admin-1', expectedVersion: before.version });
  assert.strictEqual(fresh.ok, true);
  const stale = M.setMaintenance({ method: 'crypto', enabled: false, message: 'old view', actor: 'admin-2', expectedVersion: before.version });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.reason, 'stale');
  const now = M.getMaintenance('crypto');
  assert.strictEqual(now.enabled, true, 'the newer enable must survive the stale disable');
  assert.strictEqual(now.message, 'new');
  assert.strictEqual(now.updated_by, 'admin-1');
  M.setMaintenance({ method: 'crypto', enabled: false, message: '', actor: 'a', expectedVersion: now.version });
});

await t('messages are plain text: control characters removed, whitespace collapsed, length limited', () => {
  assert.strictEqual(M.sanitizeMessage('  hi\u0000\n there\t  '), 'hi there');
  assert.strictEqual(M.sanitizeMessage('<b>x</b>'), '<b>x</b>', 'stored as text; the UI escapes it');
  assert.strictEqual(M.sanitizeMessage('a'.repeat(500)).length, M.MAX_MESSAGE_LENGTH);
  assert.strictEqual(M.sanitizeMessage(null), '');
});

await t('switch state survives a restart (child process on the same database file)', () => {
  M.setMaintenance({ method: 'inr', enabled: true, message: 'persist me', actor: 'a', expectedVersion: M.getMaintenance('inr').version });
  M.setMaintenance({ method: 'crypto', enabled: true, message: '', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
  const script = `
    const { getDb } = await import(${JSON.stringify(path.join(ROOT, 'server/db.js'))});
    const M = await import(${JSON.stringify(path.join(ROOT, 'server/lib/depositMaintenance.js'))});
    getDb();
    console.log(JSON.stringify({ inr: M.getMaintenance('inr'), crypto: M.getMaintenance('crypto') }));`;
  const child = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], {
    env: { ...process.env, SMM_TEST: '', DB_FILE }, encoding: 'utf8',
  });
  assert.strictEqual(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.strictEqual(out.inr.enabled, true);
  assert.strictEqual(out.inr.message, 'persist me');
  assert.strictEqual(out.crypto.enabled, true, 'restart must not reset an active crypto maintenance');
  M.setMaintenance({ method: 'crypto', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
});

await t('admin routes require an authenticated admin (no session is refused)', () => {
  let status = null; let nextCalled = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireAdmin({ headers: {}, socket: {}, cookies: {} }, res, () => { nextCalled = true; });
  assert.strictEqual(status, 401);
  assert.strictEqual(nextCalled, false);
});

await t('the admin maintenance router applies requireAdmin before every handler', () => {
  const src = (await_read('server/routes/admin.depositMaintenance.js'));
  assert.ok(/r\.use\(requireAdmin\)/.test(src), 'requireAdmin must guard the whole router');
  assert.ok(src.indexOf('r.use(requireAdmin)') < src.indexOf('r.put('), 'guard must come before the write route');
});

await t('a $1.00 crypto payment is confirmed with a $1.00 notification (not $0.01)', () => {
  const u = user('notice-1@test.dev');
  const d = invoice(u.id, 100);
  const before = wallet(u.id);
  const out = creditDeposit(d, { receivedUsdCents: 100 });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(wallet(u.id), before + 10000, 'wallet gets ₹100 (credit at 100 INR per USD)');
  const body = notices(u.id, 'Deposit Confirmed')[0];
  assert.ok(body && body.includes('$1.00'), `notification was: ${body}`);
  assert.ok(!body.includes('$0.01'));
});

await t('a $0.01 crypto payment is confirmed with a $0.01 notification (not $0.00)', () => {
  const u = user('notice-small@test.dev');
  const d = invoice(u.id, 1);
  assert.strictEqual(creditDeposit(d, { receivedUsdCents: 1 }).ok, true);
  const body = notices(u.id, 'Deposit Confirmed')[0];
  assert.ok(body.includes('$0.01'), `notification was: ${body}`);
});

await t('a repeated callback credits and notifies once', () => {
  const u = user('dup-cb@test.dev');
  const d = invoice(u.id, 100);
  const first = creditDeposit(d, { receivedUsdCents: 100 });
  const second = creditDeposit(d, { receivedUsdCents: 100 });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(notices(u.id, 'Deposit Confirmed').length, 1);
  assert.strictEqual(wallet(u.id), 10000);
});

await t('a failed wallet/ledger write rolls back and sends NO confirmation', () => {
  const u = user('fail-credit@test.dev');
  const d = invoice(u.id, 100);
  db.exec("CREATE TRIGGER maint_fail_ledger BEFORE INSERT ON transactions WHEN NEW.type='deposit' BEGIN SELECT RAISE(ABORT,'forced failure'); END");
  try {
    assert.throws(() => creditDeposit(d, { receivedUsdCents: 100 }), /forced failure/);
  } finally {
    db.exec('DROP TRIGGER maint_fail_ledger');
  }
  assert.strictEqual(db.prepare('SELECT status FROM deposits WHERE id=?').get(d).status, 'pending');
  assert.strictEqual(wallet(u.id), 0);
  assert.strictEqual(notices(u.id, 'Deposit Confirmed').length, 0, 'no success message when the credit failed');
});

await t('a failing notification never undoes a committed credit (notice is sent after COMMIT)', () => {
  const u = user('notify-fail@test.dev');
  const d = invoice(u.id, 100);
  db.exec("CREATE TRIGGER maint_fail_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'forced notice failure'); END");
  let out;
  try {
    out = creditDeposit(d, { receivedUsdCents: 100 });
  } finally {
    db.exec('DROP TRIGGER maint_fail_notice');
  }
  // If the notice were written inside the transaction, its failure would roll the credit back.
  assert.strictEqual(out.ok, true, 'credit must succeed even though the notice failed');
  assert.strictEqual(db.prepare('SELECT status FROM deposits WHERE id=?').get(d).status, 'confirmed');
  assert.strictEqual(wallet(u.id), 10000);
});

await t('an existing invoice still reconciles while crypto NEW invoices are paused', () => {
  const u = user('paused-existing@test.dev');
  const d = invoice(u.id, 100);
  M.setMaintenance({ method: 'crypto', enabled: true, message: 'paused', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
  assert.throws(() => M.assertDepositsOpen('crypto'), (e) => e.code === 'DEPOSIT_MAINTENANCE');
  const out = creditDeposit(d, { receivedUsdCents: 100 });
  assert.strictEqual(out.ok, true, 'reconciliation of an existing invoice must not be blocked');
  assert.strictEqual(wallet(u.id), 10000);
  M.setMaintenance({ method: 'crypto', enabled: false, message: '', actor: 'a', expectedVersion: M.getMaintenance('crypto').version });
});

await t('a partial payment is announced as partial, never as confirmed', () => {
  const u = user('partial@test.dev');
  const d = invoice(u.id, 200);
  const out = creditDeposit(d, { receivedUsdCents: 50 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 'in_progress');
  assert.strictEqual(notices(u.id, 'Deposit Confirmed').length, 0);
  assert.strictEqual(notices(u.id, 'Deposit Partially Received').length, 1);
});

await t('a zero or missing received amount credits nothing and sends nothing', () => {
  const u = user('zero-recv@test.dev');
  const d = invoice(u.id, 100);
  const out = creditDeposit(d, { receivedUsdCents: 0 });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(wallet(u.id), 0);
  assert.strictEqual(notices(u.id, 'Deposit Confirmed').length + notices(u.id, 'Deposit Partially Received').length, 0);
});

await t('INR deposits are paused by default (maintenance ON until verification is ready)', () => {
  const fresh = M.getMaintenance('inr');
  assert.strictEqual(fresh.enabled, true);
  assert.ok(fresh.message.length > 0, 'a default message is shown');
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);

function await_read(rel) {
  return readFileSyncSafe(path.join(ROOT, rel));
}
import { readFileSync } from 'node:fs';
function readFileSyncSafe(p) { return readFileSync(p, 'utf8'); }
