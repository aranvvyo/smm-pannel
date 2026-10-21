// ---------------------------------------------------------------------------
// Provider payment-event log: schema and idempotency. SQLite only, uses a
// temporary database file that is deleted afterwards. No network, no
// production data, no provider.
//   run: node scripts/test-provider-event-schema.mjs
//
//   T1  the full schema.sql applies to a fresh database
//   T2  the same provider event id cannot be recorded twice (UNIQUE)
//   T3  the same event id from a different provider is allowed
//   T4  an event may not reference a deposit that does not exist (FK)
//   T5  recording an event does not change the wallet or the deposit row
//   T6  schema.pg.sql declares the same table, columns and UNIQUE key
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
const schemaPg = readFileSync(path.join(ROOT, 'server', 'schema.pg.sql'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}: ${e.message}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'provider-events-'));
const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
db.exec('PRAGMA foreign_keys = ON');

console.log('provider payment-event schema');

check('T1 full schema.sql applies to a fresh database', () => {
  db.exec(schemaSql);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_payment_events'").get();
  assert.ok(row, 'provider_payment_events table missing');
});

// Parent rows: one user and one deposit.
db.prepare(`INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)`).run('t@example.invalid', 'x', Date.now());
const userId = Number(db.prepare('SELECT id FROM users').get().id);
db.prepare(`INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, created_at, order_id)
            VALUES (?,?,?,?,?,?,?)`).run(userId, 10000, 1000, 11000, 'pending', Date.now(), 'INSTA-T1');
const depositId = Number(db.prepare('SELECT id FROM inr_deposits').get().id);

const insertEvent = (provider, eventId, extra = {}) => db.prepare(
  `INSERT INTO provider_payment_events
     (provider, event_id, deposit_id, order_id, event_status, amount_paise, currency, source, decision, received_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
).run(provider, eventId, extra.depositId ?? depositId, 'INSTA-T1', 'SUCCESS', 11000, 'INR',
      'provider_webhook', 'auto-credit-disabled', Date.now());

check('T2 the same provider event id cannot be recorded twice', () => {
  insertEvent('provider-x', 'evt-1');
  assert.throws(() => insertEvent('provider-x', 'evt-1'), /UNIQUE/i);
});

check('T3 the same event id from a different provider is allowed', () => {
  insertEvent('provider-y', 'evt-1');
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM provider_payment_events WHERE event_id=?').get('evt-1').n);
  assert.strictEqual(n, 2);
});

check('T4 an event cannot reference a missing deposit', () => {
  assert.throws(() => insertEvent('provider-x', 'evt-missing', { depositId: 999999 }), /FOREIGN KEY/i);
});

check('T5 recording events does not change the wallet or the deposit', () => {
  const before = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(userId).wallet_balance;
  const depBefore = db.prepare('SELECT status, verified_at FROM inr_deposits WHERE id=?').get(depositId);
  insertEvent('provider-z', 'evt-2');
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(userId).wallet_balance;
  const depAfter = db.prepare('SELECT status, verified_at FROM inr_deposits WHERE id=?').get(depositId);
  assert.strictEqual(Number(after), Number(before));
  assert.strictEqual(depAfter.status, depBefore.status);
  assert.strictEqual(depAfter.verified_at, depBefore.verified_at);
});

check('T6 schema.pg.sql declares the same table, columns and UNIQUE key', () => {
  const block = schemaPg.slice(schemaPg.indexOf('CREATE TABLE IF NOT EXISTS provider_payment_events'));
  for (const col of ['provider', 'event_id', 'deposit_id', 'order_id', 'event_status', 'amount_paise',
                     'currency', 'source', 'decision', 'received_at']) {
    assert.ok(block.includes(col), `missing column ${col} in schema.pg.sql`);
  }
  assert.ok(/UNIQUE \(provider, event_id\)/.test(block), 'missing UNIQUE (provider, event_id)');
});

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\nprovider payment-event schema: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
