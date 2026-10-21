// ---------------------------------------------------------------------------
// INR payment-reference protection — SQLite database-level tests.
//   run: node scripts/test-inr-payment-ref-db.mjs
//
// No npm packages, no network, no app modules. Uses node:sqlite and the REAL
// server/schema.sql. The same partial unique index that the opt-in PostgreSQL
// migration creates is applied here, so the rule is exercised on a real engine.
//
// Covers:
//   • a verified payment reference (case-insensitive) belongs to one verified deposit
//   • pending, awaiting_verification and denied rows never collide
//   • NULL references never collide
//   • the index is refused while duplicate verified rows exist, and nothing is deleted
//   • a repeated verification changes nothing (conditional UPDATE)
//   • a second writer on a file database is refused by the index (two connections)
//   • an atomic credit rolls back completely when the ledger insert fails
// This does NOT exercise the app's verifyInrDeposit (that module imports dotenv;
// see test-inr-payment-ref-behaviour.mjs, which is not run in this environment).
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
// Same definition as docs/migrations/MIGRATION_inr_payment_ref_unique.sql (SQLite-compatible form).
const GUARD = `CREATE UNIQUE INDEX idx_inr_deposits_verified_ref ON inr_deposits (UPPER(payment_ref))
  WHERE status = 'verified' AND payment_ref IS NOT NULL`;

const dir = mkdtempSync(path.join(tmpdir(), 'instasmm-refdb-'));
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function freshDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
    (1, 'a@test.dev', 'x', 'A', 'client', 0), (2, 'b@test.dev', 'x', 'B', 'client', 0), (99, 'admin@test.dev', 'x', 'Admin', 'admin', 0)`);
  return db;
}
const insertDeposit = (db, { user = 1, credit = 10000, status = 'pending', ref = null } = {}) =>
  db.prepare(`INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, payment_ref, created_at, order_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(user, credit, Math.round(credit * 0.1), credit + Math.round(credit * 0.1), status, ref, Date.now(),
      `ORD${String(Math.random()).slice(2, 10)}`).lastInsertRowid;
const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;
const code = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('INR payment-reference DB tests (SQLite)');

await t('a verified reference can belong to only one verified deposit (case-insensitive)', () => {
  const db = freshDb();
  db.exec(GUARD);
  insertDeposit(db, { status: 'verified', ref: 'UTR123456789' });
  const e = code(() => insertDeposit(db, { user: 2, status: 'verified', ref: 'utr123456789' }));
  assert.ok(e, 'second verified row with the same reference must be refused');
  assert.match(String(e.message), /UNIQUE/i);
});

await t('pending, awaiting_verification and denied rows never collide on a reference', () => {
  const db = freshDb();
  db.exec(GUARD);
  insertDeposit(db, { status: 'pending', ref: 'REF000001' });
  insertDeposit(db, { user: 2, status: 'pending', ref: 'REF000001' });
  insertDeposit(db, { status: 'awaiting_verification', ref: 'REF000001' });
  insertDeposit(db, { user: 2, status: 'denied', ref: 'REF000001' });
  insertDeposit(db, { status: 'denied', ref: 'REF000001' });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM inr_deposits'), 5);
});

await t('NULL references never collide', () => {
  const db = freshDb();
  db.exec(GUARD);
  insertDeposit(db, { status: 'verified', ref: null });
  insertDeposit(db, { user: 2, status: 'verified', ref: null });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM inr_deposits WHERE status='verified'"), 2);
});

await t('the guard is refused while duplicate verified rows exist, and no row is deleted', () => {
  const db = freshDb();
  // Duplicates created before the guard existed (legacy data).
  insertDeposit(db, { status: 'verified', ref: 'LEGACY0001' });
  insertDeposit(db, { user: 2, status: 'verified', ref: 'legacy0001' });
  const before = count(db, 'SELECT COUNT(*) AS n FROM inr_deposits');
  const e = code(() => db.exec(GUARD));
  assert.ok(e, 'index creation must fail on existing duplicates');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM inr_deposits'), before, 'no record may be removed');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM inr_deposits WHERE status='verified'"), 2);
});

await t('a repeated verification of the same deposit changes nothing', () => {
  const db = freshDb();
  db.exec(GUARD);
  const id = insertDeposit(db, { status: 'pending' });
  const flip = db.prepare(`UPDATE inr_deposits SET status='verified', payment_ref=? WHERE id=? AND status IN ('pending','awaiting_verification')`);
  assert.equal(flip.run('REPEAT0001', id).changes, 1, 'first verification flips the row');
  assert.equal(flip.run('REPEAT0001', id).changes, 0, 'second verification must change nothing');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM inr_deposits WHERE status='verified'"), 1);
});

await t('a second connection to the same file database is refused while the first is committing', () => {
  const file = path.join(dir, 'race.db');
  const a = freshDb(file);
  a.exec(GUARD);
  const b = new DatabaseSync(file);
  b.exec('PRAGMA busy_timeout = 0');
  const idA = insertDeposit(a, { status: 'pending' });
  const idB = insertDeposit(b, { user: 2, status: 'pending' });
  a.exec('BEGIN IMMEDIATE');
  a.prepare(`UPDATE inr_deposits SET status='verified', payment_ref='RACE000001' WHERE id=?`).run(idA);
  // While A holds the write lock, B cannot even start its write.
  const busy = code(() => b.prepare(`UPDATE inr_deposits SET status='verified', payment_ref='RACE000001' WHERE id=?`).run(idB));
  assert.ok(busy && /locked|busy/i.test(String(busy.message)), `expected a lock error, got: ${busy && busy.message}`);
  a.exec('COMMIT');
  // After A commits, B's attempt with the same reference is refused by the guard.
  const dup = code(() => b.prepare(`UPDATE inr_deposits SET status='verified', payment_ref='race000001' WHERE id=?`).run(idB));
  assert.ok(dup && /UNIQUE/i.test(String(dup.message)), `expected a unique violation, got: ${dup && dup.message}`);
  a.close(); b.close();
});

await t('an atomic credit rolls back completely when the ledger insert fails', () => {
  const db = freshDb();
  db.exec(GUARD);
  const id = insertDeposit(db, { status: 'pending' });
  const before = db.prepare('SELECT wallet_balance AS b FROM users WHERE id=1').get().b;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE inr_deposits SET status='verified', payment_ref='ROLL000001' WHERE id=? AND status IN ('pending','awaiting_verification')`).run(id);
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=1').run(10000);
    // Ledger row with a NULL type violates NOT NULL: forces the failure after the balance moved.
    db.prepare(`INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, created_at) VALUES (1, NULL, 100, 0, ?, 0)`).run(id);
    db.exec('COMMIT');
    assert.fail('the ledger insert was expected to fail');
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') throw e;
    db.exec('ROLLBACK');
  }
  assert.equal(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(id).status, 'pending', 'status must roll back');
  assert.equal(db.prepare('SELECT wallet_balance AS b FROM users WHERE id=1').get().b, before, 'balance must roll back');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\ninr-payment-ref-db (SQLite): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
