// ---------------------------------------------------------------------------
// Startup regression — legacy demo-provider cleanup (server/db.js).
//
// Reproduces a realistic misconfiguration: a database created under
// SMM_TEST=1 (demo provider + seeded catalog + real placed orders) is
// later booted as a PRODUCTION instance (SMM_TEST unset). The boot must:
//   - NOT crash. Orders reference the demo services and foreign keys are
//     enforced, so deleting referenced rows must be preceded by detaching
//     the order history (this is the defect the cleanup fix addresses);
//   - remove the demo provider and its services;
//   - keep every order row readable — immutable history, detached from the
//     deleted service (LEFT JOIN keeps it in the user's order list).
//
// Two processes are required: getDb() caches its connection per process,
// and the cleanup runs at boot time under the SMM_TEST flag of THAT
// process. Phase 1 seeds (SMM_TEST=1); phase 2 boots production-style
// (SMM_TEST unset) in a child process against the SAME database file.
//
// No network is used — the demo adapter is a local simulator.
//
// Usage: node scripts/test-demo-cleanup.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- environment BEFORE any server module is imported (config.js reads it)
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-cleanup-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'cleanup.db');
process.env.ADMIN_EMAIL_1 = 'cleanup-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'cleanup-admin-pass-1';

// always clean up our own throwaway test database
process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbUrl = pathToFileURL(path.join(rootDir, 'server', 'db.js')).href;
const orderRouterUrl = pathToFileURL(path.join(rootDir, 'server', 'lib', 'orderRouter.js')).href;

const { getDb } = await import('../server/db.js');
const { placeOrder, userOrders, orderWithService } = await import('../server/lib/orderRouter.js');
// Register the demo adapter for THIS process (SMM_TEST=1) — the same
// side-effect import server/index.js performs. Without it placeOrder
// cannot route to the 'demo' provider (createAdapter throws
// "Unknown adapter: demo"). The phase-2 worker deliberately does NOT
// import it: a production boot has no demo adapter.
await import('../server/lib/providers/demo.js');

// ---------------------------------------------------------------------------
// Phase 1 — SMM_TEST=1 boot: seed the demo provider, catalog, one order.
// (Top-level asserts, mirroring test-regressions.mjs setup style.)
// ---------------------------------------------------------------------------
const db = getDb();
const demoProv = db.prepare("SELECT id FROM providers WHERE adapter='demo'").get();
assert.ok(demoProv, 'the SMM_TEST=1 seed must create the demo provider');
const svc = db.prepare('SELECT * FROM services WHERE provider_id=? AND status=1 ORDER BY id LIMIT 1').get(demoProv.id);
assert.ok(svc, 'the SMM_TEST=1 seed must create demo services');

const ins = db.prepare(
  `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
   VALUES ('cleanup-user@test.dev','x','client','Cleanup User',500000,0,'active',0,?)`
).run(Date.now());
const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(ins.lastInsertRowid));

const order = await placeOrder({ user, serviceId: svc.id, link: 'https://instagram.com/cleanup-test', quantity: svc.min });
assert.strictEqual(order.status, 'PENDING');
// The supplier order id is intentionally NOT in placeOrder's masked
// return (a client must never learn it) — read it from the DB instead.
const stored = db.prepare('SELECT service_id, provider_id, provider_order_id FROM orders WHERE id=?').get(order.id);
assert.ok(stored.provider_order_id, 'the demo order must carry a provider order id');
assert.ok(stored.service_id, 'before cleanup the order must reference the demo service');
assert.strictEqual(stored.provider_id, demoProv.id, 'before cleanup the order must reference the demo provider');

// Close the parent connection so the child process owns the file.
db.close();

// ---------------------------------------------------------------------------
// Phase 2 — production-style boot (SMM_TEST unset) in a child process.
// ---------------------------------------------------------------------------
const workerCode = `
process.env.DB_FILE = ${JSON.stringify(process.env.DB_FILE)};
delete process.env.SMM_TEST;
process.env.ADMIN_EMAIL_1 = 'cleanup-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'cleanup-admin-pass-1';
const { getDb } = await import(${JSON.stringify(dbUrl)});
const { userOrders, orderWithService } = await import(${JSON.stringify(orderRouterUrl)});
const db = getDb(); // boot — runs the legacy demo-provider cleanup here
const result = {
  demoProviders: db.prepare("SELECT COUNT(*) c FROM providers WHERE adapter='demo'").get().c,
  services: db.prepare('SELECT COUNT(*) c FROM services').get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  detached: db.prepare('SELECT service_id FROM orders ORDER BY id').all().map((r) => r.service_id),
  history: userOrders(db, ${user.id}).length,
  detailOk: orderWithService(db, ${order.id}) !== null,
};
console.log('WORKER_RESULT ' + JSON.stringify(result));
`;

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

await t('production boot (SMM_TEST unset) cleans up without crashing; order history stays readable', async () => {
  const workerPath = path.join(TEST_DIR, 'cleanup-worker.mjs');
  writeFileSync(workerPath, workerCode);
  const run = spawnSync(process.execPath, [workerPath], { encoding: 'utf8' });
  const match = (run.stdout || '').match(/WORKER_RESULT (\{.*\})/);
  let out = null;
  if (match) { try { out = JSON.parse(match[1]); } catch { out = null; } }
  assert.strictEqual(run.status, 0,
    `the production boot must not crash (stderr: ${run.stderr || 'none'})`);
  assert.ok(out, 'the worker did not emit its result');
  assert.strictEqual(out.demoProviders, 0, 'the demo provider must be removed');
  assert.strictEqual(out.services, 0, 'the demo services must be removed');
  assert.strictEqual(out.orders, 1, 'the order row must survive (immutable history)');
  assert.deepStrictEqual(out.detached, [null], 'the order must be detached from the deleted service');
  assert.strictEqual(out.history, 1, 'the user order history must remain readable');
  assert.strictEqual(out.detailOk, true, 'order detail must remain readable');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
