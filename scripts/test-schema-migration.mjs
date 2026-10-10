// Schema / migration regression tests (no framework, no network, no PostgreSQL server).
//   run: node scripts/test-schema-migration.mjs
//
// Regression: PostgreSQL startup failed with
//   column "order_id" does not exist
// because schema.pg.sql created an index on inr_deposits(order_id) BEFORE the
// migration (ensureColumns) had added that column to an EXISTING table.
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so the index
// statement ran against a table without order_id and aborted initialization.
//
// These tests reproduce that ordering on SQLite (same SQL shape, runs here)
// and statically check schema.pg.sql, which needs a live PostgreSQL to run.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
const schemaPg = readFileSync(path.join(ROOT, 'server', 'schema.pg.sql'), 'utf8');
const dbSrc = readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

// The inr_deposits table exactly as it existed in production BEFORE order_id.
const OLD_INR_DEPOSITS = `CREATE TABLE inr_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  credit_paise INTEGER NOT NULL,
  surcharge_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  invoice_ref TEXT,
  payment_ref TEXT,
  verified_by INTEGER,
  verify_note TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);`;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  PASS  ${name}`); };

console.log('Schema / migration regression tests');

t('an existing database (inr_deposits without order_id) can run schema.sql without error', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(OLD_INR_DEPOSITS);            // production state before this change
  assert.doesNotThrow(() => db.exec(schemaSql),
    'schema.sql must not reference order_id before the migration adds it');
  db.close();
});

t('schema.pg.sql creates no index on order_id (migration adds the column first)', () => {
  // Any CREATE INDEX on inr_deposits that names order_id is the failing statement.
  const statements = schemaPg.split(';').map((s) => s.trim());
  const bad = statements.filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)
    && /inr_deposits/i.test(s) && /order_id/i.test(s));
  assert.deepStrictEqual(bad, [], `index on order_id must live in the migration, not the schema: ${bad[0]}`);
});

t('schema.sql creates no index on order_id (same ordering rule for SQLite)', () => {
  const statements = schemaSql.split(';').map((s) => s.trim());
  const bad = statements.filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)
    && /inr_deposits/i.test(s) && /order_id/i.test(s));
  assert.deepStrictEqual(bad, []);
});

t('fresh schema.pg.sql still declares the order_id column for new databases', () => {
  const table = schemaPg.slice(schemaPg.indexOf('CREATE TABLE IF NOT EXISTS inr_deposits'));
  const body = table.slice(0, table.indexOf(');'));
  assert.ok(/order_id\s+TEXT/.test(body), 'order_id TEXT must be in the CREATE TABLE');
});

t('migration adds order_id and its unique index AFTER the schema runs (PostgreSQL path)', () => {
  const exec = dbSrc.indexOf('db.exec(schemaSql);');
  const migrate = dbSrc.indexOf("add('inr_deposits', 'order_id', 'TEXT');", exec);
  assert.ok(exec > 0, 'PostgreSQL schema exec not found in db.js');
  assert.ok(migrate > exec, 'order_id migration must run after the schema exec');
  const idx = dbSrc.indexOf('idx_inr_deposits_order', migrate);
  assert.ok(idx > migrate, 'the unique index must be created after the column is added');
});

t('migration is idempotent: re-running it on an upgraded database is harmless', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(OLD_INR_DEPOSITS);
  db.exec("INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, created_at) VALUES (1,10000,1000,11000,0)");
  // The exact statements db.js ensureColumns runs for this change.
  const migrate = () => {
    const have = db.prepare('PRAGMA table_info(inr_deposits)').all().some((c) => c.name === 'order_id');
    if (!have) db.exec('ALTER TABLE inr_deposits ADD COLUMN order_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_order ON inr_deposits(order_id) WHERE order_id IS NOT NULL');
  };
  migrate();
  migrate();
  const row = db.prepare('SELECT credit_paise, total_paise, order_id FROM inr_deposits').get();
  assert.strictEqual(row.credit_paise, 10000, 'existing deposit data must survive the migration');
  assert.strictEqual(row.total_paise, 11000);
  assert.strictEqual(row.order_id, null, 'legacy rows keep NULL order_id (no fabricated id)');
  db.close();
});

t('full upgrade path: old database + schema.sql + migration succeeds and keeps the data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, role TEXT, name TEXT, wallet_balance INTEGER DEFAULT 0, created_at INTEGER)');
  db.exec(OLD_INR_DEPOSITS.replace('user_id INTEGER NOT NULL,', 'user_id INTEGER NOT NULL REFERENCES users(id),'));
  db.exec("INSERT INTO users (id, email, role, name, wallet_balance, created_at) VALUES (1,'a@t.dev','client','A',5000,0)");
  db.exec("INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, created_at) VALUES (1,10000,1000,11000,'verified',0)");
  db.exec(schemaSql);                    // must not throw on the old table
  db.exec('ALTER TABLE inr_deposits ADD COLUMN order_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_order ON inr_deposits(order_id) WHERE order_id IS NOT NULL');
  assert.strictEqual(db.prepare('SELECT wallet_balance FROM users WHERE id=1').get().wallet_balance, 5000, 'wallet untouched');
  assert.strictEqual(db.prepare("SELECT status FROM inr_deposits").get().status, 'verified', 'deposit history untouched');
  db.close();
});

console.log(`\n${pass} tests passed`);
