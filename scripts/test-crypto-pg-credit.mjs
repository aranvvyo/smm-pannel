// ---------------------------------------------------------------------------
// PostgreSQL + node-postgres check of the crypto credit UPDATE.
//
// Runs the SHIPPED statement (extracted from server/lib/apirone.js and
// translated by server/lib/pgDialect.js) through the `pg` client with
// parameter values, exactly the binding path the app uses in production.
//
// Gated like test-pg-integration.mjs. It SKIPS (exit 0) unless BOTH are set:
//   TEST_DATABASE_URL       a DISPOSABLE database. Never production.
//   PG_TEST_CONFIRM_FRESH=1 explicit confirmation that tables will be created
//                           inside a transaction that is ROLLED BACK.
// It never reads DATABASE_URL. Nothing is committed.
//   run: TEST_DATABASE_URL=postgres://... PG_TEST_CONFIRM_FRESH=1 \
//          node scripts/test-crypto-pg-credit.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPgSql } from '../server/lib/pgDialect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = String(process.env.TEST_DATABASE_URL || '').trim();
if (!url || process.env.PG_TEST_CONFIRM_FRESH !== '1') {
  console.log('crypto-pg-credit: SKIP (set TEST_DATABASE_URL to a disposable DB and PG_TEST_CONFIRM_FRESH=1)');
  process.exit(0);
}

let pgMod;
try { pgMod = await import('pg'); } catch {
  console.log('crypto-pg-credit: SKIP — the `pg` package is not installed (run `npm install`)');
  process.exit(0);
}
const { Client } = pgMod.default ?? pgMod;

// The shipped statement, not a copy: extract the template from apirone.js.
const apironeSrc = readFileSync(path.join(ROOT, 'server', 'lib', 'apirone.js'), 'utf8');
const start = apironeSrc.indexOf('`UPDATE deposits SET status=?, paid_usd=?');
const end = apironeSrc.indexOf('WHERE id=?`', start) + 'WHERE id=?'.length;
assert.ok(start > 0 && end > start, 'credit UPDATE not found in apirone.js');
const SHIPPED = toPgSql(apironeSrc.slice(start + 1, end)).replace(/\s+/g, ' ').trim();

// The pre-fix statement, kept as a negative control.
const PRE_FIX = toPgSql(`UPDATE deposits SET status=?, paid_usd=?, amount_inr=?, paid_at=?, confirmed_at=?,
        received_minor=CASE WHEN ? > 0 THEN ? ELSE received_minor END,
        tx_hash=CASE WHEN ? IS NOT NULL AND ? <> '' THEN ? ELSE tx_hash END,
        provider_event=COALESCE(provider_event, ?) WHERE id=?`).replace(/\s+/g, ' ').trim();

const client = new Client({ connectionString: url });
await client.connect();
let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};

try {
  await client.query('BEGIN');
  // Minimal tables with the real column types used by the statement.
  await client.query(`CREATE TEMP TABLE deposits (id BIGSERIAL PRIMARY KEY, status TEXT, paid_usd BIGINT,
    amount_inr BIGINT, paid_at BIGINT, confirmed_at BIGINT, received_minor DOUBLE PRECISION,
    tx_hash TEXT, provider_event TEXT)`);
  const { rows: [{ id }] } = await client.query(
    "INSERT INTO deposits (status, paid_usd, amount_inr) VALUES ('pending', 0, 0) RETURNING id");
  const values = (status, paidUsd, inr, minor, hash, event) =>
    [status, paidUsd, inr, 1700000000000, status === 'confirmed' ? 1700000000000 : null,
      minor, minor, hash, hash, hash, event, id];

  await check('pre-fix statement is rejected by PostgreSQL (negative control)', async () => {
    await client.query('SAVEPOINT neg');
    await assert.rejects(
      () => client.query({ text: PRE_FIX, values: values('confirmed', 500, 5000, 0, null, 'x') }),
      /could not determine data type of parameter/);
    await client.query('ROLLBACK TO SAVEPOINT neg');
  });

  await check('shipped statement: manual confirm (no tx hash) completes the deposit', async () => {
    const r = await client.query({ text: SHIPPED, values: values('confirmed', 500, 5000, 0, null, 'credited by verified payment') });
    assert.strictEqual(r.rowCount, 1);
    const { rows } = await client.query('SELECT status, paid_usd, amount_inr FROM deposits WHERE id=$1', [id]);
    assert.deepStrictEqual(rows[0], { status: 'confirmed', paid_usd: '500', amount_inr: '5000' });
  });

  await check('shipped statement: verified webhook slice stores minor units and tx hash', async () => {
    await client.query("UPDATE deposits SET status='pending', paid_usd=0, amount_inr=0, received_minor=NULL, tx_hash=NULL, provider_event=NULL, confirmed_at=NULL WHERE id=$1", [id]);
    const r = await client.query({ text: SHIPPED, values: values('in_progress', 100, 1000, 123456, 'abc123', null) });
    assert.strictEqual(r.rowCount, 1);
    const { rows } = await client.query('SELECT status, received_minor, tx_hash FROM deposits WHERE id=$1', [id]);
    assert.deepStrictEqual(rows[0], { status: 'in_progress', received_minor: 123456, tx_hash: 'abc123' });
  });

  await check('shipped statement: a null tx hash never overwrites a stored hash', async () => {
    const r = await client.query({ text: SHIPPED, values: values('in_progress', 100, 1000, 0, null, null) });
    assert.strictEqual(r.rowCount, 1);
    const { rows } = await client.query('SELECT tx_hash FROM deposits WHERE id=$1', [id]);
    assert.strictEqual(rows[0].tx_hash, 'abc123');
  });
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}

console.log(`\ncrypto-pg-credit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
