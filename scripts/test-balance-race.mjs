// ---------------------------------------------------------------------------
// Balance-safety regression tests (SQLite, throwaway database, demo provider).
//   • concurrent cancelOrder on one order refunds exactly once
//   • admin debit cannot overdraw; the ledger matches the balance (no drift)
// The concurrency here is in-process (interleaved awaits). Cross-process and
// PostgreSQL row-lock behaviour is covered by test-pg-balance-race.mjs.
// Usage: node scripts/test-balance-race.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-balance-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'balance.db');
process.env.ADMIN_EMAIL_1 = 'balance-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'balance-admin-pass-123';
process.env.SESSION_SECRET = 'balance-session-secret';
process.env.DEMO_SPEED = '1000';
process.env.DATABASE_URL = '';

await import('../server/lib/providers/demo.js');   // side-effect: registers the demo adapter, as server/index.js does
const { getDb } = await import('../server/db.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const { placeOrder, cancelOrder } = await import('../server/lib/orderRouter.js');
const { adminAdjustBalance } = await import('../server/lib/wallet.js');
const db = getDb();
if (db.isPg) throw new Error('this suite must run on the throwaway SQLite file');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 4).join(' / ')}`); }
}
const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  ?? (() => { throw new Error('seed admin missing'); })();
const createUser = (email, balance) => {
  db.prepare(`INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
    VALUES (?,?,'client','Balance',?,0,'active',0,?)`).run(email, hashPassword('balance-pass-1'), balance, Date.now());
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
};
const wallet = (id) => Number(db.prepare('SELECT wallet_balance w FROM users WHERE id=?').get(id).w);
const ledgerSum = (id) => Number(db.prepare("SELECT COALESCE(SUM(amount_inr),0) s FROM transactions WHERE user_id=?").get(id).s);
const refundRows = (id) => db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id=? AND type='refund'").get(id).n;

console.log('Balance-safety regression tests (SQLite, in-process concurrency)');

await t('two concurrent cancels of one pending order refund exactly once', async () => {
  const svc = db.prepare(`SELECT * FROM services WHERE provider_id=(SELECT id FROM providers WHERE adapter='demo') AND cancel=1 AND status=1 ORDER BY id LIMIT 1`).get();
  assert.ok(svc, 'seeded cancel-capable demo service required');
  const user = createUser('race-cancel@test.dev', 1_000_000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/race-cancel', quantity: svc.min });
  const before = wallet(user.id);
  const results = await Promise.allSettled([
    cancelOrder({ admin, orderId: order.id }),
    cancelOrder({ admin, orderId: order.id }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, `exactly one cancel must succeed, got ${ok.length}`);
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].reason.code, 'BAD_STATUS', 'the loser must be refused as a bad status');
  assert.strictEqual(refundRows(user.id), ok[0].value.refund_inr > 0 ? 1 : 0, 'one refund ledger row at most');
  assert.strictEqual(wallet(user.id), before + ok[0].value.refund_inr, 'the wallet grows by the refund exactly once');
  assert.strictEqual(wallet(user.id), ledgerSum(user.id) + 1_000_000, 'ledger matches balance (no drift)');
});

await t('a repeated cancel after success is refused and refunds nothing', async () => {
  const svc = db.prepare(`SELECT * FROM services WHERE provider_id=(SELECT id FROM providers WHERE adapter='demo') AND cancel=1 AND status=1 ORDER BY id LIMIT 1`).get();
  const user = createUser('race-repeat@test.dev', 1_000_000);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/race-repeat', quantity: svc.min });
  await cancelOrder({ admin, orderId: order.id });
  const afterFirst = wallet(user.id);
  await assert.rejects(cancelOrder({ admin, orderId: order.id }), (e) => e.code === 'BAD_STATUS');
  assert.strictEqual(wallet(user.id), afterFirst);
});

await t('admin debit beyond the balance is refused and leaves the balance unchanged', () => {
  const user = createUser('race-debit@test.dev', 5000);
  assert.throws(() => adminAdjustBalance(admin, user.id, -5001, 'test'), (e) => e.code === 'BAD_AMOUNT');
  assert.strictEqual(wallet(user.id), 5000);
});

await t('admin debit of exactly the balance reaches zero, never negative; ledger matches', () => {
  const user = createUser('race-exact@test.dev', 5000);
  adminAdjustBalance(admin, user.id, -5000, 'test');
  assert.strictEqual(wallet(user.id), 0);
  assert.strictEqual(wallet(user.id), ledgerSum(user.id) + 5000);
  assert.throws(() => adminAdjustBalance(admin, user.id, -1, 'test'), (e) => e.code === 'BAD_AMOUNT');
  assert.strictEqual(wallet(user.id), 0);
});

await t('admin credit then debit keeps the ledger equal to the balance', () => {
  const user = createUser('race-ledger@test.dev', 0);
  adminAdjustBalance(admin, user.id, 12345, 'test');
  adminAdjustBalance(admin, user.id, -345, 'test');
  assert.strictEqual(wallet(user.id), 12000);
  assert.strictEqual(wallet(user.id), ledgerSum(user.id));
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
