// ---------------------------------------------------------------------------
// Pure unit tests for the PostgreSQL dialect translator
// (server/lib/pgDialect.js). NO database and NO `pg` dependency —
// these run in the default `npm test` chain and prove the
// translation rules the synchronous bridge relies on.
//
// Usage: node scripts/test-pg-dialect.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import {
  PG_ID_TABLES, isPragma, isUniqueViolation, wantsSsl, toPgSql,
} from '../server/lib/pgDialect.js';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e && e.message ? e.message : String(e)}`);
  }
}

// --- placeholder numbering -------------------------------------------------

await t('a single ? becomes $1', () => {
  assert.strictEqual(toPgSql('SELECT * FROM users WHERE id=?'), 'SELECT * FROM users WHERE id=$1');
});

await t('multiple ? become $1,$2,… in order', () => {
  assert.strictEqual(
    toPgSql('SELECT * FROM users WHERE email=? AND role=?'),
    'SELECT * FROM users WHERE email=$1 AND role=$2'
  );
});

await t('a ? inside a single-quoted literal is NOT a placeholder', () => {
  assert.strictEqual(
    toPgSql("SELECT * FROM users WHERE name LIKE 'what?'"),
    "SELECT * FROM users WHERE name ILIKE 'what?'"
  );
});

await t("an '' escape does not end a literal (the ? inside stays data)", () => {
  assert.strictEqual(
    toPgSql("SELECT 'it''s?' AS lit WHERE x=?"),
    "SELECT 'it''s?' AS lit WHERE x=$1"
  );
});

await t('a ? inside a line comment is NOT a placeholder', () => {
  const sql = 'SELECT 1 -- is this a ?\nFROM users';
  assert.strictEqual(toPgSql(sql), sql);
});

await t('a ? inside a block comment is NOT a placeholder', () => {
  assert.strictEqual(toPgSql('SELECT 1 /* ? */ FROM users'), 'SELECT 1 /* ? */ FROM users');
});

await t('a ? inside a double-quoted identifier is NOT a placeholder', () => {
  assert.strictEqual(
    toPgSql('SELECT "weird?col" FROM t WHERE x=?'),
    'SELECT "weird?col" FROM t WHERE x=$1'
  );
});

await t('numbering continues after $n placeholders already present', () => {
  assert.strictEqual(
    toPgSql('SELECT * FROM t WHERE a=$2 AND b=?'),
    'SELECT * FROM t WHERE a=$2 AND b=$3'
  );
});

// --- LIKE → ILIKE ----------------------------------------------------------

await t('LIKE becomes ILIKE (SQLite LIKE is ASCII-case-insensitive)', () => {
  assert.strictEqual(toPgSql('SELECT * FROM s WHERE name LIKE ?'), 'SELECT * FROM s WHERE name ILIKE $1');
});

await t('the LIKE keyword is matched case-insensitively', () => {
  assert.strictEqual(toPgSql('SELECT * FROM s WHERE name like ?'), 'SELECT * FROM s WHERE name ILIKE $1');
});

await t('LIKE inside a literal is left untouched', () => {
  assert.strictEqual(toPgSql("SELECT 'a LIKE b' AS lit"), "SELECT 'a LIKE b' AS lit");
});

// --- INSERT OR IGNORE ------------------------------------------------------

await t('INSERT OR IGNORE becomes INSERT … ON CONFLICT DO NOTHING', () => {
  assert.strictEqual(
    toPgSql('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING'
  );
});

await t('INSERT OR IGNORE is matched case-insensitively', () => {
  assert.strictEqual(
    toPgSql('insert or ignore into settings (key, value) values (?, ?)'),
    'insert into settings (key, value) values ($1, $2) ON CONFLICT DO NOTHING'
  );
});

await t('INSERT OR IGNORE keeps the original keyword casing (mixed case)', () => {
  assert.strictEqual(
    toPgSql('Insert Or Ignore into settings (key, value) values (?, ?)'),
    'Insert into settings (key, value) values ($1, $2) ON CONFLICT DO NOTHING'
  );
});

await t('an INSERT that already carries ON CONFLICT is left untouched', () => {
  const sql = 'INSERT INTO settings (key,value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value';
  assert.strictEqual(toPgSql(sql), sql);
});

await t('a trailing semicolon is preserved through the rewrite', () => {
  assert.strictEqual(
    toPgSql('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);'),
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING;'
  );
});

// --- RETURNING id ----------------------------------------------------------

await t('an INSERT into an id table gains RETURNING id', () => {
  assert.strictEqual(
    toPgSql('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id'
  );
});

await t('an INSERT into settings (natural key) gains NO RETURNING', () => {
  assert.strictEqual(
    toPgSql('INSERT INTO settings (key, value) VALUES (?, ?)'),
    'INSERT INTO settings (key, value) VALUES ($1, $2)'
  );
});

await t('an INSERT with an explicit RETURNING is left alone', () => {
  assert.strictEqual(
    toPgSql('INSERT INTO users (email) VALUES (?) RETURNING id, email'),
    'INSERT INTO users (email) VALUES ($1) RETURNING id, email'
  );
});

await t('INSERT OR IGNORE into an id table gets ON CONFLICT and RETURNING', () => {
  assert.strictEqual(
    toPgSql('INSERT OR IGNORE INTO coupons (code, type) VALUES (?, ?)'),
    'INSERT INTO coupons (code, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id'
  );
});

// --- real production statements, end to end -------------------------------

await t('the conditional wallet debit translates end to end', () => {
  assert.strictEqual(
    toPgSql(`UPDATE users
     SET wallet_balance = wallet_balance - ?, total_spent_inr = total_spent_inr + ?
     WHERE id = ? AND wallet_balance >= ?`),
    `UPDATE users
     SET wallet_balance = wallet_balance - $1, total_spent_inr = total_spent_inr + $2
     WHERE id = $3 AND wallet_balance >= $4`
  );
});

await t('the idempotent provider-order INSERT keeps its ON CONFLICT semantics available', () => {
  const out = toPgSql(
    `INSERT INTO orders (order_ref, user_id, provider_order_id) VALUES (?,?,?)`
  );
  assert.strictEqual(
    out,
    'INSERT INTO orders (order_ref, user_id, provider_order_id) VALUES ($1,$2,$3) RETURNING id'
  );
});

// --- helpers ---------------------------------------------------------------

await t('isPragma detects PRAGMA statements', () => {
  assert.strictEqual(isPragma('PRAGMA foreign_keys = ON'), true);
  assert.strictEqual(isPragma('  pragma table_info(users)'), true);
  assert.strictEqual(isPragma('SELECT 1'), false);
});

await t('isUniqueViolation accepts PostgreSQL (23505) and SQLite messages', () => {
  assert.strictEqual(
    isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"' }),
    true
  );
  assert.strictEqual(isUniqueViolation(new Error('duplicate key value violates unique constraint')), true);
  assert.strictEqual(isUniqueViolation(new Error('UNIQUE constraint failed: users.email')), true);
  assert.strictEqual(isUniqueViolation(new Error('syntax error at or near "SELECT"')), false);
  assert.strictEqual(isUniqueViolation(new Error('connection terminated unexpectedly')), false);
  assert.strictEqual(isUniqueViolation(null), false);
  assert.strictEqual(isUniqueViolation(undefined), false);
});

await t('wantsSsl reads sslmode from the connection string', () => {
  assert.strictEqual(wantsSsl('postgres://u:p@h/db?sslmode=require'), true);
  assert.strictEqual(wantsSsl('postgres://u:p@h/db?sslmode=verify-ca'), true);
  assert.strictEqual(wantsSsl('postgres://u:p@h/db?sslmode=verify-full'), true);
  assert.strictEqual(wantsSsl('postgres://u:p@h/db?sslmode=prefer'), false);
  assert.strictEqual(wantsSsl('postgres://u:p@h/db'), false);
  assert.strictEqual(wantsSsl(''), false);
});

await t('PG_ID_TABLES covers every id-bearing table (and only those)', () => {
  for (const name of [
    'users', 'categories', 'providers', 'services', 'orders', 'transactions',
    'deposits', 'coupons', 'coupon_uses', 'notifications', 'tickets',
    'ticket_replies', 'security_logs', 'withdrawals', 'inr_deposits',
  ]) {
    assert.ok(PG_ID_TABLES.has(name), `${name} must be an id table`);
  }
  for (const name of ['settings', 'sessions', 'withdraw_addresses']) {
    assert.ok(!PG_ID_TABLES.has(name), `${name} has a natural key — no RETURNING`);
  }
});

console.log(`\npg-dialect: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
