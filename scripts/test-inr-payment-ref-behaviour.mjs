// ---------------------------------------------------------------------------
// INR deposit behaviour tests — the app's own verify, deny and automatic-path code.
//   run: node scripts/test-inr-payment-ref-behaviour.mjs
//
// STATUS: NOT RUN in the current environment. server/config.js imports dotenv,
// which is not installed (npm registry is blocked by egress policy). This file
// is written against the real module exports and must be run after dependencies
// are installed from the lockfile. The database-level guarantees are covered by
// test-inr-payment-ref-db.mjs (SQLite) and test-inr-payment-ref-pg.sh (PostgreSQL),
// which DO run.
//
// Uses a throwaway SQLite file (DB_FILE). Never production. No network. No
// provider call: the automatic path is exercised with the production adapter,
// which has no confirmed contract and must make no request.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-inrbehave-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'behave.db');
process.env.ADMIN_EMAIL_1 = 'inr-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'inr-admin-pass-123';
process.env.SESSION_SECRET = 'inr-behaviour-session-secret';
process.env.DATABASE_URL = '';

const { getDb } = await import('../server/db.js');
const { config } = await import('../server/config.js');
const {
  createInrDeposit, claimInrDeposit, verifyInrDeposit, denyInrDeposit,
} = await import('../server/lib/inrDeposits.js');
const {
  verifyDepositOnce, creditVerifiedInrDeposit, automaticCreditingAllowed,
} = await import('../server/lib/inrVerification.js');
const { productionAdapter } = await import('../server/lib/vcGatewayAdapter.js');

const db = getDb();
if (db.isPg) throw new Error('this suite must run on the throwaway SQLite file');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 4).join(' / ')}`); }
}

const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
if (!admin) throw new Error('seed admin missing (login once to create it, as in test-balance-race)');
let n = 0;
const createUser = (balance = 0) => {
  n += 1;
  db.prepare(`INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
    VALUES (?,?,'client','InrBehave',?,0,'active',0,?)`).run(`inr-user-${n}@test.dev`, 'x', balance, Date.now());
  return db.prepare('SELECT * FROM users WHERE email=?').get(`inr-user-${n}@test.dev`);
};
const balanceOf = (u) => Number(db.prepare('SELECT wallet_balance AS b FROM users WHERE id=?').get(u.id).b);
const deposit = (u, rupees = 100) => {
  const r = createInrDeposit({ userId: u.id, rupees });
  assert.ok(r.ok, `createInrDeposit failed: ${r.reason}`);
  return r.deposit;
};
const ledgerCount = (u) => Number(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND type='deposit'").get(u.id).n);

console.log('INR deposit behaviour tests (app code, SQLite)');

await t('automatic crediting is OFF by default and the provider contract is not confirmed', () => {
  assert.equal(config.vcGetaway.autoCreditEnabled, false);
  assert.equal(productionAdapter.isContractConfirmed, false);
  assert.equal(automaticCreditingAllowed(), false);
});

await t('a verified payment credits the CREDIT amount exactly once', () => {
  const u = createUser(0);
  const d = deposit(u, 100);
  assert.ok(claimInrDeposit({ userId: u.id, depositId: d.id }).ok);
  const r = verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: 'UTR100000001' });
  assert.ok(r.ok, `verify failed: ${r.reason}`);
  assert.equal(balanceOf(u), 10000, 'wallet must receive the credit (₹100), not the total (₹110)');
  assert.equal(ledgerCount(u), 1);
});

await t('the same bank reference cannot verify a second deposit (case-insensitive)', () => {
  const u1 = createUser(0), u2 = createUser(0);
  const d1 = deposit(u1), d2 = deposit(u2);
  assert.ok(verifyInrDeposit({ adminId: admin.id, depositId: d1.id, paymentRef: 'UTR200000002' }).ok);
  const r = verifyInrDeposit({ adminId: admin.id, depositId: d2.id, paymentRef: 'utr200000002' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment-ref-already-used');
  assert.equal(balanceOf(u2), 0, 'the second wallet must not be credited');
  assert.equal(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(d2.id).status, 'pending');
});

await t('repeated verification of the same deposit credits nothing more', () => {
  const u = createUser(0);
  const d = deposit(u, 100);
  assert.ok(verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: 'UTR300000003' }).ok);
  const again = verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: 'UTR300000004' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-verified');
  assert.equal(balanceOf(u), 10000);
  assert.equal(ledgerCount(u), 1);
});

await t('a missing or malformed reference is rejected before any write', () => {
  const u = createUser(0);
  const d = deposit(u);
  for (const bad of [undefined, '', '  ', 'ab', 'bad ref!', 'x'.repeat(40)]) {
    const r = verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: bad });
    assert.equal(r.ok, false, `accepted reference ${JSON.stringify(bad)}`);
  }
  assert.equal(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(d.id).status, 'pending');
  assert.equal(balanceOf(u), 0);
});

await t('an administrator cannot verify a deposit they requested themselves', () => {
  const d = deposit(admin, 100);
  const r = verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: 'UTR400000005' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'self-verification-forbidden');
});

await t('a denied deposit cannot later be verified, and no credit is made', () => {
  const u = createUser(0);
  const d = deposit(u);
  assert.ok(denyInrDeposit({ adminId: admin.id, depositId: d.id, reason: 'test' }).ok);
  const r = verifyInrDeposit({ adminId: admin.id, depositId: d.id, paymentRef: 'UTR500000006' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already-denied');
  assert.equal(balanceOf(u), 0);
});

await t('two verifications of different deposits in sequence: only the first credits', () => {
  // verifyInrDeposit is synchronous: calls cannot interleave inside one process.
  // Cross-process races are covered by the SQLite and PostgreSQL database tests.
  const u1 = createUser(0), u2 = createUser(0);
  const d1 = deposit(u1), d2 = deposit(u2);
  const results = [
    verifyInrDeposit({ adminId: admin.id, depositId: d1.id, paymentRef: 'UTR600000007' }),
    verifyInrDeposit({ adminId: admin.id, depositId: d2.id, paymentRef: 'UTR600000007' }),
  ];
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one deposit may take the reference');
  assert.equal(balanceOf(u1) + balanceOf(u2), 10000, 'exactly one credit in total');
});

await t('a customer claim never credits', () => {
  const u = createUser(0);
  const d = deposit(u);
  claimInrDeposit({ userId: u.id, depositId: d.id });
  assert.equal(balanceOf(u), 0);
  assert.equal(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(d.id).status, 'awaiting_verification');
});

await t('the automatic path with the production adapter makes no credit and reports unavailable', async () => {
  const u = createUser(0);
  const d = deposit(u);
  const out = await verifyDepositOnce({ depositId: d.id });
  assert.equal(out.credited, false);
  assert.equal(out.state, 'unavailable');
  assert.equal(balanceOf(u), 0);
});

await t('a credit cannot be forged: an unissued verification token is refused', () => {
  const u = createUser(0);
  const d = deposit(u);
  const r = creditVerifiedInrDeposit({ depositId: d.id, verification: { orderId: d.order_id, totalPaise: d.total_paise } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-verification');
  assert.equal(balanceOf(u), 0);
});

rmSync(TEST_DIR, { recursive: true, force: true });
console.log(`\ninr-behaviour: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
