// ---------------------------------------------------------------------------
// Refill and cancel regression tests.
// MOCKED supplier only: no network, no real supplier orders, no money moved
// outside a throwaway SQLite file.
//   run: node scripts/test-refill-cancel.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'refill-cancel-'));
process.env.DB_FILE = path.join(TEST_DIR, 'refill-cancel.db');
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
process.env.ADMIN_EMAIL_1 = 'refill-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'refill-admin-pass-1';
process.env.SESSION_SECRET = 'refill-session-secret';

let unexpectedFetch = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const { getDb } = await import(path.join(ROOT, 'server', 'db.js'));
const { registerProviderAdapter } = await import(path.join(ROOT, 'server', 'lib/provider.js'));
const orderRouter = await import(path.join(ROOT, 'server', 'lib/orderRouter.js'));
const R = await import(path.join(ROOT, 'server', 'lib/orderRefill.js'));

const db = getDb();
if (db.isPg) throw new Error('test-refill-cancel must run on the temporary SQLite file');

// ---- mock supplier ----------------------------------------------------------
const supplier = {
  calls: { refill: 0, cancel: 0, status: 0 },
  refill: async () => ({ refill: 'R-DEFAULT' }),
  cancel: async () => ({}),
  status: async () => ({ status: 'Canceled', remains: 0 }),
};
registerProviderAdapter('mockrefill', () => ({
  kind: 'mock',
  async refill(id) { supplier.calls.refill++; return supplier.refill(id); },
  async cancel(id) { supplier.calls.cancel++; return supplier.cancel(id); },
  async orderStatus(id) { supplier.calls.status++; return supplier.status(id); },
}));

const now = Date.now();
db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run('Test', 'test-cat');
const provider = db.prepare(
  `INSERT INTO providers (name, adapter, api_url, api_key, active, created_at, updated_at)
   VALUES ('Mock', 'mockrefill', 'https://supplier.invalid/api', 'TEST-KEY-NOT-REAL', 1, ?, ?)`
).run(now, now);
const providerId = Number(provider.lastInsertRowid);
const catId = Number(db.prepare('SELECT id FROM categories WHERE slug=?').get('test-cat').id);
const svcRefill = Number(db.prepare(
  `INSERT INTO services (category_id, provider_id, provider_service_id, name, type, min, max, provider_rate, admin_rate, refill, cancel, status, created_at)
   VALUES (?, ?, 'S1', 'Refillable test', 'Default', 1, 999999, 1, 2, 1, 1, 1, ?)`
).run(catId, providerId, now).lastInsertRowid);
const svcPlain = Number(db.prepare(
  `INSERT INTO services (category_id, provider_id, provider_service_id, name, type, min, max, provider_rate, admin_rate, refill, cancel, status, created_at)
   VALUES (?, ?, 'S2', 'Plain test', 'Default', 1, 999999, 1, 2, 0, 0, 1, ?)`
).run(catId, providerId, now).lastInsertRowid);

function makeUser(tag) {
  const r = db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?, 'not-a-real-hash', 'client', ?, 0, 0, 'active', 0, ?)`
  ).run(`${tag}-${now}@test.dev`, tag, now);
  return Number(r.lastInsertRowid);
}
const owner = makeUser('owner');
const stranger = makeUser('stranger');
let refCounter = 0;
function makeOrder({ userId = owner, serviceId = svcRefill, status = 'COMPLETED', quantity = 1000, price = 1000, remains = 0 } = {}) {
  const t = Date.now();
  const n = ++refCounter;
  const r = db.prepare(
    `INSERT INTO orders (order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity, price_inr, base_cost_inr, status, start_count, remains, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'https://example.test/profile', ?, ?, 0, ?, 0, ?, ?, ?)`
  ).run(`TST-${n}-${t}`, userId, serviceId, providerId, `PV-${n}-${t}`, quantity, price, status, remains, t, t);
  return Number(r.lastInsertRowid);
}
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
const refillRows = (id) => db.prepare('SELECT status, provider_refill_id FROM order_refill_requests WHERE order_id=? ORDER BY id').all(id);
const balance = (userId) => Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(userId).wallet_balance);
const resetCalls = () => { supplier.calls.refill = 0; supplier.calls.cancel = 0; supplier.calls.status = 0; };
const isErr = (code) => (e) => e && e.code === code;

// Real refill call through the single entry point, as the customer route does it.
function customerRefill(orderId, userId = owner) {
  const order = orderRow(orderId);
  const service = db.prepare('SELECT id, refill FROM services WHERE id=?').get(order.service_id);
  const prov = db.prepare('SELECT id, adapter, api_url, api_key, active FROM providers WHERE id=?').get(order.provider_id);
  return R.requestRefill({ db, order, service, provider: prov, actor: 'customer', userId });
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log(`  PASS  ${name}`); }
  catch (e) { results.push(['FAIL', name]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('Refill and cancel tests (mocked supplier)\n');

await t('[1] proportional refund: integer paise, half-up rounding, capped at price', () => {
  assert.strictEqual(R.proportionalRefund(1000, 1000, 900), 900);   // ₹10 for 1000, 900 unused → ₹9
  assert.strictEqual(R.proportionalRefund(1000, 1000, 100), 100);
  assert.strictEqual(R.proportionalRefund(1000, 3, 1), 333);        // 333.33 → 333
  assert.strictEqual(R.proportionalRefund(1000, 3, 2), 667);        // 666.67 → 667
  assert.strictEqual(R.proportionalRefund(1, 2, 1), 1);             // 0.5 → 1 (half up)
  assert.strictEqual(R.proportionalRefund(1000, 1000, 0), 0);
  assert.strictEqual(R.proportionalRefund(1000, 10, 50), 1000);     // unused clamped to quantity
  assert.throws(() => R.proportionalRefund(1000, 0, 1), RangeError);
});

await t('[2] refill refused on a service that does not support refill (no supplier call)', async () => {
  resetCalls();
  const id = makeOrder({ serviceId: svcPlain });
  await assert.rejects(() => customerRefill(id), isErr('REFILL_NOT_SUPPORTED'));
  assert.strictEqual(supplier.calls.refill, 0);
});

await t('[3] another customer cannot refill an order they do not own (404, no supplier call)', async () => {
  resetCalls();
  const id = makeOrder();
  await assert.rejects(() => customerRefill(id, stranger), isErr('NOT_FOUND'));
  assert.strictEqual(supplier.calls.refill, 0);
});

await t('[4] customer refill refused while the order is still PENDING (no supplier call)', async () => {
  resetCalls();
  const id = makeOrder({ status: 'PENDING' });
  await assert.rejects(() => customerRefill(id), isErr('REFILL_NOT_AVAILABLE'));
  assert.strictEqual(supplier.calls.refill, 0);
});

await t('[5] eligible order: supplier returns an id → ACCEPTED; order status and wallet unchanged', async () => {
  resetCalls();
  const id = makeOrder();
  const before = balance(owner);
  supplier.refill = async () => ({ refill: 'R-100' });
  const out = await customerRefill(id);
  assert.deepStrictEqual(out, { ok: true, status: 'ACCEPTED' });
  assert.strictEqual(supplier.calls.refill, 1);
  assert.strictEqual(orderRow(id).status, 'COMPLETED', 'a refill must not change the order status');
  assert.strictEqual(orderRow(id).remains, 0, 'a refill must not change remains');
  assert.strictEqual(balance(owner), before, 'a refill must not move money');
  const rows = refillRows(id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'ACCEPTED');
  assert.strictEqual(rows[0].provider_refill_id, 'R-100');
});

await t('[6] duplicate customer refill on the same order is blocked with no second supplier call', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => ({ refill: 'R-200' });
  await customerRefill(id);
  resetCalls();
  await assert.rejects(() => customerRefill(id), isErr('REFILL_ALREADY_REQUESTED'));
  assert.strictEqual(supplier.calls.refill, 0);
  assert.strictEqual(refillRows(id).length, 1);
});

await t('[7] concurrent customer refills: exactly one supplier call', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => { await new Promise((r) => setTimeout(r, 20)); return { refill: 'R-300' }; };
  const settled = await Promise.allSettled([customerRefill(id), customerRefill(id), customerRefill(id)]);
  assert.strictEqual(supplier.calls.refill, 1, 'supplier must be called once');
  assert.strictEqual(settled.filter((s) => s.status === 'fulfilled').length, 1);
  assert.strictEqual(refillRows(id).length, 1);
});

await t('[8] admin refill goes through the same audited path and leaves the order unchanged', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => ({ refill: 'R-400' });
  const out = await orderRouter.refillOrder({ admin: { id: 1, email: 'refill-admin@test.dev' }, orderId: id });
  assert.strictEqual(out.status, 'ACCEPTED');
  assert.strictEqual(orderRow(id).status, 'COMPLETED');
  assert.strictEqual(refillRows(id)[0].provider_refill_id, 'R-400');
});

await t('[9] supplier explicit refusal → REJECTED, nothing changed, customer may try again', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => { throw Object.assign(new Error('refill not allowed'), { kind: 'rejected', category: 'provider_rejected' }); };
  await assert.rejects(() => customerRefill(id), isErr('REFILL_REJECTED'));
  assert.strictEqual(refillRows(id)[0].status, 'REJECTED');
  assert.strictEqual(orderRow(id).status, 'COMPLETED');
  supplier.refill = async () => ({ refill: 'R-500' });
  const out = await customerRefill(id);
  assert.strictEqual(out.status, 'ACCEPTED');
  assert.strictEqual(supplier.calls.refill, 2);
});

await t('[10] supplier timeout → AMBIGUOUS, held for review, and blocks a resubmission', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => { throw Object.assign(new Error('timeout'), { kind: 'unknown', category: 'timeout' }); };
  await assert.rejects(() => customerRefill(id), isErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(refillRows(id)[0].status, 'AMBIGUOUS');
  resetCalls();
  await assert.rejects(() => customerRefill(id), isErr('REFILL_ALREADY_REQUESTED'));
  assert.strictEqual(supplier.calls.refill, 0, 'must not retry an unconfirmed refill');
});

await t('[11] supplier reply without a refill id is not treated as accepted', async () => {
  resetCalls();
  const id = makeOrder();
  supplier.refill = async () => ({ status: 'ok' });
  await assert.rejects(() => customerRefill(id), isErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(refillRows(id)[0].status, 'AMBIGUOUS');
});

await t('[12] customer-facing order view exposes refill flags and status, never supplier ids', () => {
  const id = makeOrder();
  const masked = orderRouter.orderWithService(db, id);
  assert.strictEqual(masked.refill_supported, 1);
  assert.ok(!('provider_order_id' in masked));
  assert.ok(!('provider_refill_id' in masked));
  assert.ok(!('api_key' in masked));
  const list = orderRouter.userOrders(db, owner).find((o) => o.id === id);
  assert.ok(list && list.refill_supported === 1);
});

await t('[13] cancel: refund uses the supplier-confirmed unused quantity (₹10 for 1000, 900 unused → ₹9), once', async () => {
  resetCalls();
  const id = makeOrder({ status: 'IN_PROGRESS', quantity: 1000, price: 1000 });
  supplier.cancel = async () => ({});
  supplier.status = async () => ({ status: 'Canceled', remains: 900 });
  const before = balance(owner);
  const out = await orderRouter.cancelOrder({ admin: { id: 1, email: 'a' }, orderId: id });
  assert.strictEqual(out.refund_inr, 900);
  assert.strictEqual(balance(owner), before + 900);
  assert.strictEqual(orderRow(id).status, 'CANCELED');
  // duplicate cancel: no second refund, no second supplier cancel
  resetCalls();
  await assert.rejects(() => orderRouter.cancelOrder({ admin: { id: 1, email: 'a' }, orderId: id }), isErr('BAD_STATUS'));
  assert.strictEqual(balance(owner), before + 900, 'duplicate cancel must not refund again');
  assert.strictEqual(supplier.calls.cancel, 0);
});

await t('[14] cancel: HTTP success alone is not enough; unconfirmed status → no refund, order unchanged', async () => {
  const id = makeOrder({ status: 'PENDING', quantity: 1000, price: 1000 });
  supplier.cancel = async () => ({});
  supplier.status = async () => { throw new Error('status endpoint down'); };
  const before = balance(owner);
  await assert.rejects(() => orderRouter.cancelOrder({ admin: { id: 1, email: 'a' }, orderId: id }), isErr('PROVIDER_ERROR'));
  assert.strictEqual(balance(owner), before);
  assert.strictEqual(orderRow(id).status, 'PENDING');
});

await t('[15] cancel: supplier still reports the order in progress → no refund', async () => {
  const id = makeOrder({ status: 'PENDING', quantity: 1000, price: 1000 });
  supplier.cancel = async () => ({});
  supplier.status = async () => ({ status: 'In progress', remains: 900 });
  const before = balance(owner);
  await assert.rejects(() => orderRouter.cancelOrder({ admin: { id: 1, email: 'a' }, orderId: id }), isErr('PROVIDER_ERROR'));
  assert.strictEqual(balance(owner), before);
  assert.strictEqual(orderRow(id).status, 'PENDING');
});

await t('[16] cancel: implausible supplier remains (more than ordered) → no refund', async () => {
  const id = makeOrder({ status: 'PENDING', quantity: 1000, price: 1000 });
  supplier.cancel = async () => ({});
  supplier.status = async () => ({ status: 'Canceled', remains: 5000 });
  const before = balance(owner);
  await assert.rejects(() => orderRouter.cancelOrder({ admin: { id: 1, email: 'a' }, orderId: id }), isErr('PROVIDER_ERROR'));
  assert.strictEqual(balance(owner), before);
});

await t('[17] ledger: a cancel refund is recorded as exactly one refund transaction', () => {
  const rows = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE type='refund' AND user_id=?").get(owner);
  assert.ok(Number(rows.c) >= 1);
  const sum = db.prepare("SELECT COALESCE(SUM(amount_inr),0) AS s FROM transactions WHERE type='refund' AND user_id=?").get(owner);
  assert.strictEqual(Number(sum.s), 900, 'only the one confirmed refund should exist');
});

// ---- summary ----------------------------------------------------------------
globalThis.fetch = realFetch;
const passed = results.filter((r) => r[0] === 'PASS').length;
const failed = results.filter((r) => r[0] === 'FAIL').length;
assert.strictEqual(unexpectedFetch, 0, `unexpected network calls: ${unexpectedFetch}`);
console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
if (failed) process.exit(1);
