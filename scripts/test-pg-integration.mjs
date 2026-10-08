// ---------------------------------------------------------------------------
// Gated PostgreSQL integration suite — PARENT.
//
// Runs ONLY when BOTH gates are set:
//   TEST_DATABASE_URL     a connection string the suite may use to
//                         CREATE/DROP a scratch database (a
//                         "maintenance" connection, e.g. to the
//                         cluster's default database)
//   PG_TEST_CONFIRM_FRESH=1  explicit confirmation that creating and
//                         dropping a uniquely named scratch database
//                         is acceptable
//
// Safety model:
//   • The suite runs ONLY against its own scratch database
//     (`instasmm_pg_test_<unique>`): it CREATES it, boots the
//     real app against it in a CHILD process, runs the
//     invariants, then DROPS it. If the scratch database
//     cannot be created the suite ABORTS — it never falls
//     back to TEST_DATABASE_URL (or the ambient DATABASE_URL),
//     so it can never run against, or write into, an existing
//     installation.
//   • Cleanup is reliable on normal exit, child failure, child
//     timeout (the child wait is bounded; the child is
//     SIGTERM'd, then SIGKILL'd after a grace period), and
//     handled SIGINT/SIGTERM. The child is always terminated
//     FIRST: DROP DATABASE refuses while any session (the
//     child's bridge) is still connected. Every maintenance
//     operation is bounded (connect timeout, CREATE/DROP
//     query budgets, overall cleanup budget), so no path can
//     hang indefinitely; a signal arriving during setup waits
//     for the CREATE to settle before dropping, so cleanup
//     can never drop before the create lands.
//   • LIMITATION: an uncatchable termination of THIS parent
//     (SIGKILL, OOM kill, power loss) leaves the scratch
//     database behind. Orphan recovery — run against a
//     maintenance connection and review the list BEFORE
//     dropping (the pattern matches only this suite's
//     generated names):
//       SELECT datname FROM pg_database
//        WHERE datname LIKE 'instasmm_pg_test_%';
//       DROP DATABASE "<exact name from the list>";
//   • No data is ever migrated, copied or deleted outside the
//     scratch database. The connection string and credentials
//     are never printed.
//
// Usage:
//   TEST_DATABASE_URL='postgres://…' PG_TEST_CONFIRM_FRESH=1 \
//     npm run test:pg
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'test-pg-integration.child.mjs');

const TEST_DB = String(process.env.TEST_DATABASE_URL || '').trim();
const CONFIRM = String(process.env.PG_TEST_CONFIRM_FRESH || '').trim() === '1';

if (!TEST_DB || !CONFIRM) {
  console.log('pg-integration: SKIPPED — this suite is gated. Run it with:');
  console.log('');
  console.log('  TEST_DATABASE_URL=\'postgres://user:pass@host/db?sslmode=require\' \\');
  console.log('  PG_TEST_CONFIRM_FRESH=1 npm run test:pg');
  console.log('');
  console.log('It creates a uniquely named scratch database, boots the app');
  console.log('against it, runs the invariants, then drops the scratch');
  console.log('database. It never runs against a database that already');
  console.log('contains InstaMM tables.');
  process.exit(0);
}

let pg = null;
try {
  pg = await import('pg');
} catch {
  console.error('pg-integration: the `pg` package is not installed — run `npm install` first.');
  process.exit(1);
}

// Reject anything that is not a PostgreSQL connection string
// BEFORE any connection is attempted. The value itself is
// never printed — it contains credentials.
if (!/^postgres(?:ql)?:\/\//i.test(TEST_DB)) {
  console.error('pg-integration: TEST_DATABASE_URL must be a postgres:// or postgresql:// connection string.');
  process.exit(1);
}

// Uniquely named, always a valid lowercase identifier (never a
// collision with an existing database, and safe to quote).
const scratchName = `instasmm_pg_test_${Date.now().toString(36)}${process.pid.toString(36)}`;
if (!/^[a-z_][a-z0-9_]*$/.test(scratchName)) {
  console.error('pg-integration: generated an unsafe database name — aborting.');
  process.exit(1);
}

const connect = () => new pg.Client({
  connectionString: TEST_DB,
  // Bounded connect; overridable so the safety tests can
  // exercise timeout and signal paths in milliseconds.
  // Production default: 15 seconds.
  connect_timeout: Number(process.env.PG_TEST_CONNECT_TIMEOUT_MS) || 15,
});

// The signal path's cleanup connection gets its own
// (short) connect timeout so termination stays snappy
// even when the maintenance server is slow or
// unreachable: cleanup must complete — or fail closed —
// without waiting out the main connect timeout. The
// overall cleanup budget (below) still bounds it.
const connectCleanup = () => new pg.Client({
  connectionString: TEST_DB,
  connect_timeout: Number(process.env.PG_TEST_CLEANUP_CONNECT_TIMEOUT_MS) || 15,
});

// ── Cleanup: drop ONLY this run's scratch database ──
// The child wait is bounded so a hung child can never leave
// the parent (and the scratch database) hanging forever.
const CHILD_TIMEOUT_MS = Number(process.env.PG_TEST_CHILD_TIMEOUT_MS) || 600_000;
const KILL_GRACE_MS = 5_000;
const CREATE_TIMEOUT_MS = 30_000;   // CREATE DATABASE query budget
const CLEANUP_TIMEOUT_MS = Number(process.env.PG_TEST_CLEANUP_BUDGET_MS) || 45_000; // overall cleanup budget (connect + DROP)
const CREATE_SETTLE_MS = 5_000;     // max wait for an in-flight CREATE to land
let child = null;          // assigned at spawn below
let cleanupPromise = null; // one shared, awaited cleanup
let createInFlight = false; // true between CREATE start and its commit/abort

// Bounded await: never let a maintenance operation hang the
// suite. On timeout the operation is abandoned (its client is
// closed fire-and-forget by the caller) and the error thrown.
// NOTE: an abandoned CREATE DATABASE may still commit later —
// that orphan is covered by the documented recovery procedure.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanup(reason) {
  if (cleanupPromise) return cleanupPromise; // re-entrant: await the same run
  cleanupPromise = (async () => {
    // The child holds a connection to the scratch database
    // (its bridge worker); DROP DATABASE refuses while any
    // session is connected, so terminate the child FIRST.
    if (child) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }
      // Attach the exit listener BEFORE checking exitCode:
      // if the child died between a late check and the
      // listener registration the event would be missed and
      // cleanup would hang forever. SIGKILL (above) guarantees
      // the exit event fires, so this wait is bounded.
      await new Promise((resolve) => {
        child.once('exit', resolve);
        if (child.exitCode !== null) resolve();
      });
    }
    // A CREATE DATABASE may still be committing (a signal can
    // arrive during setup): give it a bounded moment to land
    // so this cleanup can never drop BEFORE the create — which
    // would leave the scratch database behind as an orphan.
    if (createInFlight) {
      const deadline = Date.now() + CREATE_SETTLE_MS;
      while (createInFlight && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    // Re-validate the exact generated name before using it:
    // cleanup may drop only this run's scratch database.
    if (!/^instasmm_pg_test_[a-z0-9]+$/.test(scratchName)) {
      console.error('pg-integration: refusing to drop an invalid scratch name — NOT dropping anything.');
      process.exit(1);
    }
    const cleaner = connectCleanup();
    try {
      // Bounded overall: the connect (≤ connect_timeout) plus
      // the DROP must finish inside the cleanup budget — a hung
      // maintenance session must never hang cleanup.
      await withTimeout(
        (async () => {
          await cleaner.connect();
          await cleaner.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
        })(),
        CLEANUP_TIMEOUT_MS,
        'scratch database cleanup'
      );
      console.log(`pg-integration: dropped scratch database "${scratchName}" (${reason})`);
    } catch (e) {
      console.error(`pg-integration: WARNING — could not drop the scratch database: ${e.message}`);
      console.error(`                Drop "${scratchName}" manually when convenient.`);
    } finally {
      // Fire-and-forget: the process exits immediately after
      // cleanup, so a graceful shutdown that never completes
      // cannot hang the suite.
      cleaner.end().catch(() => {});
    }
  })();
  return cleanupPromise;
}

// Handled termination: clean up, then exit with the
// conventional signal exit code (130 = SIGINT, 143 = SIGTERM).
let interrupted = null;
function onSignal(signal) {
  if (interrupted) return; // cleanup already in progress (bounded)
  interrupted = signal;
  console.error(`pg-integration: received ${signal} — terminating the child and dropping the scratch database.`);
  cleanup(`interrupted by ${signal}`)
    .then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    .catch(() => process.exit(1));
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// Readiness marker for the safety tests: at this point
// the signal handlers are registered and the parent is
// about to park in the maintenance connect. The marker
// never includes the URL or any credentials.
console.log('pg-integration: setup started (maintenance connection pending)');

// Create the scratch database. If this fails — e.g. the role has
// no CREATEDB privilege on a pooled/serverless tier — the suite
// ABORTS. There is deliberately NO fallback to TEST_DATABASE_URL:
// the supplied database may hold a live installation, and this
// suite must never run against (or write into) it.
const maintenance = connect();
try {
  await maintenance.connect();
  createInFlight = true;
  try {
    await withTimeout(
      maintenance.query(`CREATE DATABASE "${scratchName}"`),
      CREATE_TIMEOUT_MS,
      'CREATE DATABASE'
    );
    console.log(`pg-integration: created scratch database "${scratchName}"`);
  } catch (createErr) {
    console.error('pg-integration: CREATE DATABASE failed — aborting, nothing was run.');
    console.error('                This suite only ever runs against its own scratch');
    console.error('                database; it never falls back to TEST_DATABASE_URL.');
    console.error('                Grant CREATEDB to the role (or point TEST_DATABASE_URL');
    console.error('                at a maintenance connection) and re-run.');
    console.error(`                (error: ${createErr.message})`);
    process.exit(1);
  } finally {
    createInFlight = false;
  }
} catch (e) {
  console.error('pg-integration: cannot connect to TEST_DATABASE_URL — aborting.');
  console.error(`                (error: ${e.message})`);
  process.exit(1);
} finally {
  maintenance.end().catch(() => {}); // fire-and-forget (see cleanup)
}

if (interrupted) {
  // A termination signal arrived during setup: stop BEFORE
  // spawning the child. The signal handler's cleanup (the
  // shared, awaited run) drops the scratch database, and the
  // process exits with the conventional signal code.
  await cleanup(`interrupted by ${interrupted} during setup`);
  process.exit(interrupted === 'SIGINT' ? 130 : 143);
}

// The child boots against the scratch database ONLY — never the
// supplied TEST_DATABASE_URL, and never the ambient DATABASE_URL
// (overwritten below). The maintenance-connection gate variables
// are deleted from the child's environment, so the child can
// only ever reach the scratch database.
let targetUrl;
try {
  targetUrl = new URL(TEST_DB);
  targetUrl.pathname = `/${scratchName}`;
} catch {
  console.error('pg-integration: TEST_DATABASE_URL is not a parseable URL — aborting.');
  process.exit(1);
}
const childEnv = {
  ...process.env,
  DATABASE_URL: targetUrl.toString(),
  SMM_TEST: '1',
  DEMO_SPEED: '1000',
  SESSION_SECRET: process.env.SESSION_SECRET || 'pg-integration-secret',
  ADMIN_EMAIL_1: process.env.ADMIN_EMAIL_1 || 'pg-admin@test.dev',
  ADMIN_PASSWORD_1: process.env.ADMIN_PASSWORD_1 || 'pg-admin-pass-123',
  // The child never touches a real SQLite file: point DB_FILE at
  // a throwaway path (it is unused while DATABASE_URL is set).
  DB_FILE: path.join(tmpdir(), `instasmm-pg-integration-${process.pid}.db`),
};
delete childEnv.TEST_DATABASE_URL;
delete childEnv.PG_TEST_CONFIRM_FRESH;

child = spawn(process.execPath, [CHILD], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

// Bounded wait for the child: a hung child is terminated
// (SIGTERM, then SIGKILL after a grace period — SIGKILL
// guarantees the exit event fires), then cleaned up.
let childTimedOut = false;
const code = await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    childTimedOut = true;
    console.error(`pg-integration: child exceeded ${CHILD_TIMEOUT_MS}ms — terminating it, then cleaning up.`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);
  child.once('exit', (c) => {
    clearTimeout(timeout);
    resolve(c);
  });
});

await cleanup('child exit');

if (childTimedOut || code == null) {
  console.error('pg-integration: child did not complete successfully.');
  process.exit(1);
}
if (interrupted) process.exit(interrupted === 'SIGINT' ? 130 : 143);
process.exit(code);
