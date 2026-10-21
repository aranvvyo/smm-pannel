// ---------------------------------------------------------------------------
// INR deposit controls: duplicate claims, wrong amounts, unauthorized access,
// repeated or reused admin credits. Temporary SQLite file only; no network,
// no provider, no production data. Automatic crediting stays disabled.
//   run: node scripts/test-inr-deposit-controls.mjs
//
//   S1  client deposit routes require auth and filter every query by the caller
//   S2  admin deposit routes require an admin
//   S3  only verifyInrDeposit and creditVerifiedInrDeposit move wallet money
//   U1  a user cannot claim or read another user's deposit
//   A1  wrong or unsafe amounts never create a deposit row
//   A2  a valid amount computes credit, 10% surcharge and total exactly
//   C1  a duplicate customer claim is refused and changes nothing
//   V1  verification without a payment reference is refused
//   V2  a malformed payment reference is refused
//   V3  verification credits the CREDIT amount (never the total), once
//   V4  repeated verification of the same deposit credits nothing more
//   V5  one payment reference cannot verify a second deposit
//   V6  whitespace around a reference is ignored for the reuse check
//   V7  an admin cannot verify a deposit they own
//   V8  a denied or verified deposit cannot be verified or denied again
//   V9  a refused credit attempt leaves the wallet and ledger untouched
//   X1  the provider-check path never credits while automatic crediting is off
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `inr-deposit-controls-${process.pid}.db`);
process.env.DB_FILE = DB_FILE;
process.env.VCGETAWAY_API_KEY = '';
// Empty values stop dotenv (loaded by config.js) from pointing this test at a real database.
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';

// Forbid any real network call from this suite.
let unexpectedFetch = 0;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const { config } = await import(path.join(ROOT, 'server', 'config.js'));
const inr = await import(path.join(ROOT, 'server', 'lib', 'inrDeposits.js'));
const ver = await import(path.join(ROOT, 'server', 'lib', 'inrVerification.js'));
const ad = await import(path.join(ROOT, 'server', 'lib', 'vcGatewayAdapter.js'));
const db = dbm.getDb();
if (db.isPg) throw new Error('test-inr-deposit-controls must run on the temporary SQLite file, not PostgreSQL');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}

// ---- fixtures -------------------------------------------------------------
const now = Date.now();
const ins = db.prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?,?,?)');
ins.run('admin@example.invalid', 'x', 'admin', now);
ins.run('alice@example.invalid', 'x', 'client', now);
ins.run('bob@example.invalid', 'x', 'client', now);
const idOf = (email) => Number(db.prepare('SELECT id FROM users WHERE email=?').get(email).id);
const ADMIN = idOf('admin@example.invalid');
const ALICE = idOf('alice@example.invalid');
const BOB = idOf('bob@example.invalid');
const wallet = (uid) => Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(uid).wallet_balance);
const depRow = (id) => db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(id);
const depCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM inr_deposits').get().n);
const ledgerCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='deposit'").get().n);

console.log('INR deposit controls');

// ---- S: static route and module guards ------------------------------------
const clientRoutes = readFileSync(path.join(ROOT, 'server/routes/client.inrDeposits.js'), 'utf8');
const adminRoutes = readFileSync(path.join(ROOT, 'server/routes/admin.inrDeposits.js'), 'utf8');
const depositsSrc = readFileSync(path.join(ROOT, 'server/lib/inrDeposits.js'), 'utf8');
const verifySrc = readFileSync(path.join(ROOT, 'server/lib/inrVerification.js'), 'utf8');

await t('S1 client deposit routes require auth', () => {
  assert.ok(/r\.use\(requireAuth\)/.test(clientRoutes));
});
await t('S1 every client deposit query is filtered by the caller id', () => {
  const selects = clientRoutes.split('\n').filter((l) => /FROM inr_deposits/.test(l));
  assert.ok(selects.length >= 3, 'expected at least three client queries');
  for (const l of selects) assert.ok(/user_id\s*=\s*\?|user_id=\?/.test(l) || /user_id=\?/.test(l), `unfiltered query: ${l.trim()}`);
});
await t('S2 admin deposit routes require an admin', () => {
  assert.ok(/r\.use\(requireAdmin\)/.test(adminRoutes));
});
await t('S3 only the two audited credit functions write to the wallet', () => {
  const credits = (src) => (src.match(/wallet_balance\s*=\s*wallet_balance\s*\+/g) || []).length;
  assert.strictEqual(credits(depositsSrc), 1, 'inrDeposits.js must have exactly one wallet credit');
  assert.strictEqual(credits(verifySrc), 1, 'inrVerification.js must have exactly one wallet credit');
});

// ---- A: amounts ------------------------------------------------------------
await t('A1 wrong or unsafe amounts never create a deposit row', () => {
  const before = depCount();
  for (const bad of ['0', '-5', '1.234', 'abc', '', 0.5, NaN, Infinity, '1e3', null, undefined]) {
    const out = inr.createInrDeposit({ userId: ALICE, rupees: bad });
    assert.strictEqual(out.ok, false, `accepted ${String(bad)}`);
  }
  assert.strictEqual(depCount(), before, 'a refused amount wrote a row');
});
await t('A2 a valid amount computes credit, surcharge and total exactly', () => {
  const out = inr.createInrDeposit({ userId: ALICE, rupees: '100' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(Number(out.deposit.credit_paise), 10000);
  assert.strictEqual(Number(out.deposit.surcharge_paise), 1000);
  assert.strictEqual(Number(out.deposit.total_paise), 11000);
  assert.strictEqual(out.deposit.status, 'pending');
  assert.ok(/^ORD\d{6}\S{6}$/.test(out.deposit.order_id), 'order id must be server-generated');
});

// Alice's pending deposit used by several tests below.
const alicePending = Number(inr.createInrDeposit({ userId: ALICE, rupees: '100' }).deposit.id);
const bobPending = Number(inr.createInrDeposit({ userId: BOB, rupees: '100' }).deposit.id);

// ---- U / C: claims and authorization ---------------------------------------
await t('U1 a user cannot claim another user’s deposit', () => {
  const out = inr.claimInrDeposit({ userId: BOB, depositId: alicePending });
  assert.deepStrictEqual([out.ok, out.reason], [false, 'not-found']);
  assert.strictEqual(depRow(alicePending).status, 'pending');
});
await t('C1 a duplicate customer claim is refused and changes nothing', () => {
  const first = inr.claimInrDeposit({ userId: ALICE, depositId: alicePending });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(depRow(alicePending).status, 'awaiting_verification');
  const second = inr.claimInrDeposit({ userId: ALICE, depositId: alicePending });
  assert.deepStrictEqual([second.ok, second.reason], [false, 'not-pending']);
  assert.strictEqual(depRow(alicePending).status, 'awaiting_verification');
});

// ---- V: admin verification --------------------------------------------------
const creditOf = (id) => Number(depRow(id).credit_paise);

await t('V1 verification without a payment reference is refused', () => {
  const before = wallet(ALICE);
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: alicePending, paymentRef: undefined, note: 'x' });
  assert.deepStrictEqual([out.ok, out.reason], [false, 'payment-ref-required-or-invalid']);
  assert.strictEqual(wallet(ALICE), before);
  assert.strictEqual(depRow(alicePending).status, 'awaiting_verification');
});
await t('V2 a malformed payment reference is refused', () => {
  for (const bad of ['paid', 'has spaces here', 'REF;DROP', 'x'.repeat(36), '   ']) {
    const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: alicePending, paymentRef: bad, note: 'x' });
    assert.strictEqual(out.reason, 'payment-ref-required-or-invalid', `accepted ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(depRow(alicePending).status, 'awaiting_verification');
});
await t('V3 verification credits the CREDIT amount, never the total, once', () => {
  const before = wallet(ALICE);
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: alicePending, paymentRef: 'UTR100000000001', note: 'matched' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.inr, 10000);
  assert.strictEqual(wallet(ALICE) - before, creditOf(alicePending), 'wallet must rise by the credit only');
  assert.strictEqual(depRow(alicePending).status, 'verified');
  assert.strictEqual(depRow(alicePending).payment_ref, 'UTR100000000001');
});
await t('V4 repeated verification of the same deposit credits nothing more', () => {
  const before = wallet(ALICE);
  const ledger = ledgerCount();
  for (let i = 0; i < 5; i++) {
    const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: alicePending, paymentRef: 'UTR100000000001', note: 'again' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'already-verified');
  }
  assert.strictEqual(wallet(ALICE), before, 'wallet changed on a repeated verify');
  assert.strictEqual(ledgerCount(), ledger, 'ledger grew on a repeated verify');
});

const carolPending = Number(inr.createInrDeposit({ userId: BOB, rupees: '50' }).deposit.id);
inr.claimInrDeposit({ userId: BOB, depositId: carolPending });

await t('V5 one payment reference cannot verify a second deposit', () => {
  const before = wallet(BOB);
  const ledger = ledgerCount();
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: carolPending, paymentRef: 'UTR100000000001', note: 'same payment' });
  assert.deepStrictEqual([out.ok, out.reason], [false, 'payment-ref-already-used']);
  assert.strictEqual(wallet(BOB), before, 'second deposit was credited from the same payment');
  assert.strictEqual(ledgerCount(), ledger);
  assert.strictEqual(depRow(carolPending).status, 'awaiting_verification');
});
await t('V6 whitespace around a reference is ignored for the reuse check', () => {
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: carolPending, paymentRef: '  UTR100000000001  ', note: 'padded' });
  assert.strictEqual(out.reason, 'payment-ref-already-used');
  assert.strictEqual(depRow(carolPending).status, 'awaiting_verification');
});
await t('V7 an admin cannot verify a deposit they own', () => {
  const own = Number(inr.createInrDeposit({ userId: ADMIN, rupees: '100' }).deposit.id);
  inr.claimInrDeposit({ userId: ADMIN, depositId: own });
  const before = wallet(ADMIN);
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: own, paymentRef: 'UTR100000000077', note: 'self' });
  assert.deepStrictEqual([out.ok, out.reason], [false, 'self-verification-forbidden']);
  assert.strictEqual(wallet(ADMIN), before);
  assert.strictEqual(depRow(own).status, 'awaiting_verification');
});
await t('V8 a denied deposit cannot be verified, and a verified deposit cannot be denied', () => {
  const denied = Number(inr.createInrDeposit({ userId: BOB, rupees: '100' }).deposit.id);
  assert.strictEqual(inr.denyInrDeposit({ adminId: ADMIN, depositId: denied, reason: 'not received' }).ok, true);
  const before = wallet(BOB);
  const v = inr.verifyInrDeposit({ adminId: ADMIN, depositId: denied, paymentRef: 'UTR100000000088', note: 'late' });
  assert.strictEqual(v.reason, 'already-denied');
  assert.strictEqual(wallet(BOB), before);

  const d = inr.denyInrDeposit({ adminId: ADMIN, depositId: alicePending, reason: 'late deny' });
  assert.strictEqual(d.reason, 'already-verified');
  assert.strictEqual(depRow(alicePending).status, 'verified');
});
await t('V9 a refused credit leaves the wallet and ledger untouched', () => {
  const before = { alice: wallet(ALICE), bob: wallet(BOB), ledger: ledgerCount() };
  inr.verifyInrDeposit({ adminId: ADMIN, depositId: 999999, paymentRef: 'UTR100000000099', note: 'x' });
  inr.verifyInrDeposit({ adminId: ADMIN, depositId: carolPending, paymentRef: 'UTR100000000001', note: 'x' });
  assert.deepStrictEqual({ alice: wallet(ALICE), bob: wallet(BOB), ledger: ledgerCount() }, before);
});

await t('V10 the same reference in a different case is the same payment', () => {
  const lower = Number(inr.createInrDeposit({ userId: BOB, rupees: '30' }).deposit.id);
  inr.claimInrDeposit({ userId: BOB, depositId: lower });
  const before = wallet(BOB);
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: lower, paymentRef: 'utr100000000001', note: 'lower case' });
  assert.strictEqual(out.reason, 'payment-ref-already-used');
  assert.strictEqual(wallet(BOB), before);
});
await t('V11 references are stored in upper case', () => {
  const d = Number(inr.createInrDeposit({ userId: BOB, rupees: '40' }).deposit.id);
  inr.claimInrDeposit({ userId: BOB, depositId: d });
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: d, paymentRef: ' utr-fresh-000222 ', note: 'mixed' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(depRow(d).payment_ref, 'UTR-FRESH-000222');
  const meta = JSON.parse(db.prepare("SELECT meta_json FROM transactions WHERE type='deposit' AND ref_id=?").get(d).meta_json);
  assert.strictEqual(meta.payment_ref, 'UTR-FRESH-000222', 'ledger must hold the normalized reference');
});
await t('V12 a failure inside the transaction rolls back the status change', () => {
  // Orphan deposit: its user row does not exist, so the wallet step must fail.
  db.exec('PRAGMA foreign_keys = OFF');
  const orphan = db.prepare(
    `INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, created_at, order_id)
     VALUES (999999, 10000, 1000, 11000, 'awaiting_verification', ?, 'ORDORPHAN000001')`
  ).run(Date.now());
  db.exec('PRAGMA foreign_keys = ON');
  const id = Number(orphan.lastInsertRowid);
  const out = inr.verifyInrDeposit({ adminId: ADMIN, depositId: id, paymentRef: 'UTR-ORPHAN-0001', note: 'orphan' });
  assert.strictEqual(out.reason, 'user-not-found');
  assert.strictEqual(depRow(id).status, 'awaiting_verification', 'status must not change when the credit cannot be made');
  assert.strictEqual(depRow(id).payment_ref, null);
  assert.strictEqual(depRow(id).verified_at, null);
});

// ---- X: automatic path stays off -------------------------------------------
await t('X1 the provider-check path never credits while automatic crediting is off', async () => {
  assert.strictEqual(config.vcGetaway.autoCreditEnabled, false, 'automatic crediting must be off');
  const pending = Number(inr.createInrDeposit({ userId: BOB, rupees: '100' }).deposit.id);
  const before = wallet(BOB);
  const out = await ver.verifyDepositOnce({ depositId: pending, adapter: ad.productionAdapter });
  assert.strictEqual(out.credited, false);
  assert.notStrictEqual(out.state, 'verified');
  assert.strictEqual(wallet(BOB), before);
  assert.strictEqual(depRow(pending).status, 'pending');
  assert.strictEqual(unexpectedFetch, 0, 'no network call was allowed');
});

// ---- M: database-enforced uniqueness (SQLite equivalent of the PG migration)
await t('M1 the partial unique index rejects a second verified deposit with the same reference', () => {
  // Same rule as docs/migrations/MIGRATION_inr_payment_ref_unique.sql.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_verified_ref
           ON inr_deposits (UPPER(payment_ref)) WHERE status = 'verified' AND payment_ref IS NOT NULL`);
  const pending = Number(inr.createInrDeposit({ userId: BOB, rupees: '60' }).deposit.id);
  assert.throws(() => db.prepare(
    `UPDATE inr_deposits SET status='verified', payment_ref='utr-fresh-000222' WHERE id=?`).run(pending), /UNIQUE/i);
  assert.strictEqual(depRow(pending).status, 'pending');
  // A denied row may reuse a reference: only verified rows are constrained.
  db.prepare(`UPDATE inr_deposits SET status='denied', payment_ref='UTR-FRESH-000222' WHERE id=?`).run(pending);
  assert.strictEqual(depRow(pending).status, 'denied');
});

db.close?.();
rmSync(DB_FILE, { force: true });
console.log(`\nINR deposit controls: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
