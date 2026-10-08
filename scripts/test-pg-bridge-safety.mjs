// ---------------------------------------------------------------------------
// Focused safety tests for the PostgreSQL bridge and the gated
// integration suite's environment gates. NO database is ever
// contacted:
//
//   • The gate tests spawn scripts/test-pg-integration.mjs with
//     a gate missing — the parent prints its usage and exits
//     BEFORE importing `pg` or opening any connection.
//   • The timeout test points the bridge at a dummy TCP listener
//     that accepts connections but never speaks the PostgreSQL
//     protocol, so the query hangs until the (test-shortened)
//     timeout fires. It then asserts the bridge HALTS and the
//     next query fails fast — a late response can never be
//     mistaken for a later query result.
//
// Run: node scripts/test-pg-bridge-safety.mjs  (part of `npm test`)
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Set BEFORE the bridge module is first imported: the timeout
// path is exercised in milliseconds instead of a real minute.
// The production default (unset) remains 60 seconds.
process.env.PG_QUERY_TIMEOUT_MS = '300';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.join(HERE, 'test-pg-integration.mjs');

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

// Spawn the gated integration PARENT with a scrubbed environment.
// The gate must trip before `pg` is imported or any connection is
// opened, so these runs never touch a database.
function runParent(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PARENT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

console.log('PG — bridge & gate safety (no database contacted)');

await t('gate: without TEST_DATABASE_URL the suite SKIPs (exit 0, no connection)', async () => {
  const r = await runParent({});
  assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.ok(r.out.includes('SKIPPED'), 'the skip notice must be printed');
  assert.ok(r.out.includes('TEST_DATABASE_URL'), 'the usage must name the required variable');
});

await t('gate: TEST_DATABASE_URL without PG_TEST_CONFIRM_FRESH=1 SKIPs (exit 0)', async () => {
  const r = await runParent({ TEST_DATABASE_URL: 'postgres://testuser:testpass@127.0.0.1:5432/testdb' });
  assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.ok(r.out.includes('SKIPPED'), 'the skip notice must be printed');
});

await t('gate: PG_TEST_CONFIRM_FRESH=1 without TEST_DATABASE_URL SKIPs (exit 0)', async () => {
  const r = await runParent({ PG_TEST_CONFIRM_FRESH: '1' });
  assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.ok(r.out.includes('SKIPPED'), 'the skip notice must be printed');
});

await t('bridge: createPgBridge rejects empty and non-postgres connection strings', async () => {
  const { createPgBridge } = await import('../server/lib/pgSync.js');
  assert.throws(() => createPgBridge(''), /empty/);
  assert.throws(() => createPgBridge('mysql://user:pass@host/db'), /postgres/);
  assert.throws(() => createPgBridge('not-a-url'), /postgres/);
});

await t('timeout: a hung query halts the bridge and the next query fails fast (no stale result possible)', async () => {
  let pgInstalled = true;
  try { await import('pg'); } catch { pgInstalled = false; }
  if (!pgInstalled) {
    console.log('        SKIP — the `pg` package is not installed (run `npm install` first)');
    return;
  }
  const { createPgBridge } = await import('../server/lib/pgSync.js');
  // A listener that accepts TCP connections but never speaks the
  // PostgreSQL protocol: the client connects, then waits forever
  // for a startup reply — exactly the "worker never answers"
  // case the 60s timeout guards against.
  const listener = net.createServer(() => { /* accept, stay silent */ });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  const bridge = createPgBridge(`postgres://bridge:test@127.0.0.1:${port}/postgres`);
  try {
    const t0 = Date.now();
    // The bridge is a SYNCHRONOUS facade (the node:sqlite
    // contract): query errors are THROWN, not rejected —
    // so assert.throws, not assert.rejects (a synchronous
    // throw inside assert.rejects' function propagates as
    // the failure itself instead of being matched).
    assert.throws(
      () => bridge.prepare('SELECT 1').get(),
      /timed out/,
      'the first query must throw on the (shortened) timeout'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 10_000, `the timeout must fire promptly (took ${elapsed}ms)`);
    // After a timeout the bridge is HALTED: the next query must
    // fail IMMEDIATELY with the fail-closed error — it is never
    // posted, so a late response to the old query cannot be
    // misread as this query's result.
    const t1 = Date.now();
    assert.throws(
      () => bridge.prepare('SELECT 1').get(),
      /halted after a query timeout/,
      'the next query must refuse to run on the halted bridge'
    );
    // The exec() path funnels through the same guard.
    assert.throws(
      () => bridge.exec('SELECT 1'),
      /halted after a query timeout/,
      'exec() must also refuse to run on the halted bridge'
    );
    assert.ok(Date.now() - t1 < 2_000, 'the halted bridge must fail fast, not wait again');
  } finally {
    bridge.close();
    listener.close();
    delete process.env.PG_QUERY_TIMEOUT_MS;
  }
});

await t('parent: SIGTERM during setup is handled — the handler runs, exits 143 on its own, and the exit is distinguishable from a connection failure', async () => {
  // A listener that accepts TCP but never speaks PostgreSQL.
  // NO database is contacted — only a local dummy listener.
  // The parent's MAIN maintenance connect is pended far
  // beyond this test's window, so the unrelated
  // "cannot connect to TEST_DATABASE_URL" failure (exit 1)
  // can never fire: the ONLY way the parent can exit
  // within the window is its signal handler, whose
  // cleanup is short-bounded so it always completes and
  // exits 143.
  const listener = net.createServer(() => { /* accept, stay silent */ });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  const parent = spawn(process.execPath, [PARENT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEST_DATABASE_URL: `postgres://sigtest:sigtest@127.0.0.1:${port}/postgres`,
      PG_TEST_CONFIRM_FRESH: '1',
      // Main connect: pends far beyond the test window.
      PG_TEST_CONNECT_TIMEOUT_MS: '600',
      // The signal path's cleanup connect: fails fast.
      PG_TEST_CLEANUP_CONNECT_TIMEOUT_MS: '1',
      // Guaranteed bound on the handler's cleanup, so the
      // handler ALWAYS completes (fail-closed) in time —
      // even if the pg connect timeout never fires.
      PG_TEST_CLEANUP_BUDGET_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  parent.stderr.on('data', (d) => { out += d; });
  // Deterministic readiness: wait until the parent has
  // booted, registered its signal handlers and parked in
  // the maintenance connect — never a fixed sleep (a slow
  // boot used to let SIGTERM arrive BEFORE handler
  // registration, so the DEFAULT disposition killed the
  // process and 'exit' reported code=null). Bounded so a
  // broken boot fails loudly instead of hanging.
  const READY = 'pg-integration: setup started';
  const readyDeadline = Date.now() + 20_000;
  while (!out.includes(READY)) {
    if (Date.now() > readyDeadline) {
      parent.kill('SIGKILL');
      assert.fail(`parent never reached setup (signal handlers never registered)\n${out}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  parent.kill('SIGTERM');
  // Bounded wait. The exit code is captured from 'exit';
  // output is asserted only after 'close' (stdio fully
  // drained — 'exit' can fire before the last 'data'
  // events). A hang (or the forced SIGKILL below) leaves
  // code null and FAILS the test — it is never accepted
  // as graceful handling.
  let code = null;
  await new Promise((resolve) => {
    const killer = setTimeout(() => { parent.kill('SIGKILL'); }, 15_000);
    parent.once('exit', (c) => { code = c; });
    parent.once('close', () => { clearTimeout(killer); resolve(); });
  });
  listener.close();
  assert.ok(code !== null, 'the parent exited on its own after SIGTERM (no indefinite hang)');
  assert.ok(out.includes('received SIGTERM'), `the signal handler must run\n${out}`);
  // The handler's OWN exit is 143 (128 + SIGTERM), reached
  // only after its bounded cleanup completed. The main
  // flow's unrelated connect failure exits 1 — with the
  // main connect pended beyond the test window that path
  // is unreachable here, so 143 proves the signal itself
  // was handled.
  assert.strictEqual(code, 143, `the exit must be the signal handler's own (143), not an unrelated failure\n${out}`);
  // The handler's cleanup actually attempted the drop.
  assert.ok(
    out.includes('could not drop the scratch database'),
    `the signal handler's cleanup must have attempted the drop\n${out}`
  );
  // Proof the exit was NOT the unrelated connection
  // failure, and that the parent failed closed: no
  // scratch database was created and no child spawned.
  assert.ok(
    !out.includes('cannot connect to TEST_DATABASE_URL'),
    `the exit must not be the main flow's connect failure\n${out}`
  );
  assert.ok(
    !out.includes('created scratch database'),
    `the parent must fail closed — no scratch database and no child\n${out}`
  );
});

console.log(`\npg-bridge-safety: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
