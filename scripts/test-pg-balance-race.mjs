// ---------------------------------------------------------------------------
// PostgreSQL balance-race tests. Real concurrency: many separate psql sessions
// run at the same time against one database. The SQL is the same shape the
// app uses (conditional UPDATEs and atomic arithmetic); the "naive" cases are
// the old read-modify-write shapes, kept to show the race is real on PG.
//
// This uses the psql binary, not the app's pg bridge (the `pg` package is not
// installed here). It proves the SQL pattern under PG row locking, not the
// app's bridge code. Run ONLY against a disposable database:
//   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=<name>_test \
//   PG_TEST_CONFIRM_FRESH=1 node scripts/test-pg-balance-race.mjs
// Creates and drops only its own uniquely named schema.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const db = process.env.PGDATABASE || '';
if (process.env.PG_TEST_CONFIRM_FRESH !== '1' || !process.env.PGHOST || !/_test$/.test(db)) {
  console.log('PG balance-race: SKIPPED (set PGHOST, PGDATABASE=<name>_test and PG_TEST_CONFIRM_FRESH=1).');
  process.exit(0);
}
const PSQL = process.env.PSQL || 'psql';
const SCHEMA = `balance_race_${process.pid}`;
const N = 20;

function psql(sql) {
  return new Promise((resolve) => {
    const p = spawn(PSQL, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    p.stdin.end(`SET search_path TO ${SCHEMA};\n${sql}\n`);
  });
}
const runMany = (sqls) => Promise.all(sqls.map((s) => psql(s)));
// Command tags (SET, UPDATE 1, SELECT 1, DO, ...) and blank lines are not data.
const TAG = /^(SET|DO|PREPARE|EXECUTE|DEALLOCATE|BEGIN|COMMIT|CREATE \w+|DROP \w+|INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|)$/;
const one = async (sql) => {
  const r = await psql(sql);
  assert.strictEqual(r.code, 0, r.err);
  const data = r.out.split('\n').filter((l) => !TAG.test(l.trim()));
  return data.length ? data[data.length - 1] : '';
};
const bal = async (id) => Number(await one(`SELECT wallet_balance FROM users WHERE id=${id};`));
const cnt = async (q) => Number(await one(q));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 4).join(' / ')}`); }
}

console.log(`PG balance-race tests (psql, ${N} concurrent sessions, schema ${SCHEMA})`);
const setup = await psql(`
  CREATE SCHEMA ${SCHEMA};
  SET search_path TO ${SCHEMA};
  CREATE TABLE users (id BIGINT PRIMARY KEY, wallet_balance BIGINT NOT NULL);
  CREATE TABLE orders (id BIGINT PRIMARY KEY, status TEXT NOT NULL, remains BIGINT NOT NULL DEFAULT 0);
  CREATE TABLE transactions (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, type TEXT NOT NULL, amount_inr BIGINT NOT NULL);
  CREATE TABLE deposits (id BIGINT PRIMARY KEY, status TEXT NOT NULL, paid_usd BIGINT NOT NULL DEFAULT 0);
  INSERT INTO users VALUES (1, 0), (2, 1000);
  INSERT INTO orders VALUES (1, 'PENDING', 10), (2, 'PENDING', 10);
  INSERT INTO deposits VALUES (1, 'pending', 0);
`);
assert.strictEqual(setup.code, 0, `schema setup failed: ${setup.err}`);

try {
  await t('atomic credit (x = x + ?) loses no updates under concurrency', async () => {
    await one(`UPDATE users SET wallet_balance=0 WHERE id=1;`);
    await runMany(Array.from({ length: N }, () => `UPDATE users SET wallet_balance = wallet_balance + 100 WHERE id=1; SELECT pg_sleep(0.1);`));
    assert.strictEqual(await bal(1), N * 100);
  });

  await t('naive read-modify-write credit DOES lose updates (shows the race is real)', async () => {
    await one(`UPDATE users SET wallet_balance=0 WHERE id=1;`);
    await runMany(Array.from({ length: N }, () => `DO $$ DECLARE b BIGINT; BEGIN
        SELECT wallet_balance INTO b FROM users WHERE id=1; PERFORM pg_sleep(0.1);
        UPDATE users SET wallet_balance = b + 100 WHERE id=1; END $$;`));
    assert.ok((await bal(1)) < N * 100, 'the naive pattern must lose updates here');
  });

  await t('conditional debit (x = x - ? WHERE x >= ?) never overdraws; exactly 10 of 20 succeed', async () => {
    await one(`UPDATE users SET wallet_balance=1000 WHERE id=2;`);
    const res = await runMany(Array.from({ length: N }, () => `PREPARE d AS UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2 AND wallet_balance >= $1;
        EXECUTE d(100, 2); DEALLOCATE d; SELECT pg_sleep(0.05);`));
    const wins = res.filter((r) => r.out.split('\n').includes('UPDATE 1')).length;
    assert.strictEqual(wins, 10);
    assert.strictEqual(await bal(2), 0);
  });

  await t('naive check-then-write debit DOES overdraw (shows the race is real)', async () => {
    await one(`UPDATE users SET wallet_balance=1000 WHERE id=2; DELETE FROM transactions;`);
    await runMany(Array.from({ length: N }, () => `DO $$ DECLARE b BIGINT; BEGIN
        SELECT wallet_balance INTO b FROM users WHERE id=2; PERFORM pg_sleep(0.1);
        IF b >= 100 THEN
          UPDATE users SET wallet_balance = b - 100 WHERE id=2;
          INSERT INTO transactions (user_id, type, amount_inr) VALUES (2, 'order', -100);
        END IF; END $$;`));
    // Every session passed the check on the same stale 1000 and debited it.
    assert.ok((await cnt(`SELECT COUNT(*) FROM transactions WHERE user_id=2;`)) > 10, 'the naive pattern must debit more than the balance allows');
  });

  await t('cancel claim + refund: exactly one refund under 10 concurrent cancels', async () => {
    await one(`UPDATE users SET wallet_balance=0 WHERE id=1; DELETE FROM transactions; UPDATE orders SET status='PENDING' WHERE id=1;`);
    await runMany(Array.from({ length: 10 }, () => `DO $$ DECLARE n INT; BEGIN
        UPDATE orders SET status='CANCELED', remains=0 WHERE id=1 AND status IN ('PENDING','IN_PROGRESS');
        GET DIAGNOSTICS n = ROW_COUNT; PERFORM pg_sleep(0.3);
        IF n = 1 THEN
          UPDATE users SET wallet_balance = wallet_balance + 500 WHERE id=1;
          INSERT INTO transactions (user_id, type, amount_inr) VALUES (1, 'refund', 500);
        END IF; END $$;`));
    assert.strictEqual(await cnt(`SELECT COUNT(*) FROM transactions WHERE type='refund';`), 1);
    assert.strictEqual(await bal(1), 500);
    assert.strictEqual(await one(`SELECT status FROM orders WHERE id=1;`), 'CANCELED');
  });

  await t('naive pre-check cancel DOES double-refund (shows the race is real)', async () => {
    await one(`UPDATE users SET wallet_balance=0 WHERE id=1; DELETE FROM transactions; UPDATE orders SET status='PENDING' WHERE id=2;`);
    await runMany(Array.from({ length: 10 }, () => `DO $$ DECLARE s TEXT; b BIGINT; BEGIN
        SELECT status INTO s FROM orders WHERE id=2; PERFORM pg_sleep(0.3);
        IF s IN ('PENDING','IN_PROGRESS') THEN
          UPDATE orders SET status='CANCELED' WHERE id=2;
          SELECT wallet_balance INTO b FROM users WHERE id=1;
          UPDATE users SET wallet_balance = b + 500 WHERE id=1;
          INSERT INTO transactions (user_id, type, amount_inr) VALUES (1, 'refund', 500);
        END IF; END $$;`));
    assert.ok((await cnt(`SELECT COUNT(*) FROM transactions WHERE type='refund';`)) > 1, 'the naive pattern must double-refund here');
  });

  await t('crypto credit guard (status and paid_usd still as read): exactly one of 10 updates applies', async () => {
    await one(`UPDATE deposits SET status='pending', paid_usd=0 WHERE id=1;`);
    const res = await runMany(Array.from({ length: 10 }, () => `PREPARE g AS UPDATE deposits SET status='confirmed', paid_usd=$1
        WHERE id=$2 AND status=$3 AND COALESCE(paid_usd, 0)=$4;
        EXECUTE g(100, 1, 'pending', 0); DEALLOCATE g;`));
    const wins = res.filter((r) => r.out.split('\n').includes('UPDATE 1')).length;
    assert.strictEqual(wins, 1, `winners=${wins}`);
    assert.strictEqual(await one(`SELECT paid_usd FROM deposits WHERE id=1;`), '100');
  });
} finally {
  const drop = await psql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`);
  if (drop.code !== 0) console.log(`  WARN  could not drop schema ${SCHEMA}: ${drop.err}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
