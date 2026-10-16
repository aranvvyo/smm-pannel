// ---------------------------------------------------------------------------
// Client refill tests (Refill button, eligibility, supplier refill and refill_status).
// The supplier is a FIXTURE: every HTTP call goes to a scripted reply. No network, no
// real supplier order, no money moved. Runs on a throwaway SQLite file.
//   run: node scripts/test-client-refill.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'client-refill-'));
const API_KEY = 'FIXTURE-KEY-DO-NOT-USE-0123456789';
process.env.DB_FILE = path.join(TEST_DIR, 'client-refill.db');
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
process.env.ADMIN_EMAIL_1 = 'refill-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'refill-admin-pass-1';
process.env.SESSION_SECRET = 'client-refill-session-secret';
process.env.REFILL_ENABLED = '1'; // the gate is off by default; the suite exercises the enabled path

// ---- fixture supplier (replaces fetch for the supplier host only) -----------
const realFetch = globalThis.fetch;
let unexpectedFetch = 0;
const supplierCalls = [];
let supplierReply = null; // (form) => { status, text } | throws
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://supplier.invalid/')) {
    unexpectedFetch++;
    throw new Error('network disabled in tests');
  }
  const form = Object.fromEntries(new URLSearchParams(String(init.body || '')));
  supplierCalls.push(form);
  const reply = await supplierReply(form);
  return new Response(reply.text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
};
const json = (obj, status = 200) => ({ status, text: JSON.stringify(obj) });

const { getDb } = await import(path.join(ROOT, 'server', 'db.js'));
const { registerProviderAdapter } = await import(path.join(ROOT, 'server', 'lib/provider.js'));
await import(path.join(ROOT, 'server', 'lib/providers/smmpost.js')); // registers 'smmpost'
const orderRouter = await import(path.join(ROOT, 'server', 'lib/orderRouter.js'));
const R = await import(path.join(ROOT, 'server', 'lib/orderRefill.js'));

const db = getDb();
if (db.isPg) throw new Error('test-client-refill must run on the temporary SQLite file');

// A second adapter whose behaviour is scripted per test (for guard and admin tests).
const scripted = { refill: async () => ({ refill: 'MOCK-R-1' }), refillStatus: undefined };
registerProviderAdapter('mockrefill', () => ({
  kind: 'mock',
  async refill(id) { return scripted.refill(id); },
  ...(scripted.refillStatus ? { async refillStatus(id) { return scripted.refillStatus(id); } } : {}),
}));

// ---- seed -------------------------------------------------------------------
const now = Date.now();
db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run('Refill tests', 'refill-tests');
const catId = Number(db.prepare('SELECT id FROM categories WHERE slug=?').get('refill-tests').id);
const insertProvider = (name, adapter, active = 1) => Number(db.prepare(
  `INSERT INTO providers (name, adapter, api_url, api_key, active, created_at, updated_at)
   VALUES (?, ?, 'https://supplier.invalid/api', ?, ?, ?, ?)`
).run(name, adapter, API_KEY, active, now, now).lastInsertRowid);
const smmProv = insertProvider('Fixture SMM', 'smmpost');
const mockProv = insertProvider('Fixture mock', 'mockrefill');
const inactiveProv = insertProvider('Fixture inactive', 'smmpost', 0);
const insertService = (providerId, sid, refill) => Number(db.prepare(
  `INSERT INTO services (category_id, provider_id, provider_service_id, name, type, min, max, provider_rate, admin_rate, refill, cancel, status, created_at)
   VALUES (?, ?, ?, ?, 'Default', 1, 999999, 1, 2, ?, 0, 1, ?)`
).run(catId, providerId, sid, `Svc ${sid}`, refill, now).lastInsertRowid);
const svcRefillSmm = insertService(smmProv, 'S-REFILL', 1);
const svcNoRefill = insertService(smmProv, 'S-PLAIN', 0);
const svcRefillMock = insertService(mockProv, 'M-REFILL', 1);
const svcInactive = insertService(inactiveProv, 'S-INACTIVE', 1);

const makeUser = (tag) => Number(db.prepare(
  `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
   VALUES (?, 'not-a-real-hash', 'client', ?, 0, 0, 'active', 0, ?)`
).run(`${tag}-${now}@test.dev`, tag, now).lastInsertRowid);
const owner = makeUser('owner');
const stranger = makeUser('stranger');

let orderSeq = 0;
function makeOrder({ userId = owner, serviceId = svcRefillSmm, providerId = smmProv, status = 'COMPLETED', providerOrderId = `SUP-${orderSeq + 1}`, remains = 0 } = {}) {
  const n = ++orderSeq;
  const t = Date.now();
  return Number(db.prepare(
    `INSERT INTO orders (order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity, price_inr, base_cost_inr, status, start_count, remains, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'https://example.test/profile', 1000, 4500, 0, ?, 0, ?, ?, ?)`
  ).run(`CLR-${n}-${t}`, userId, serviceId, providerId, providerOrderId, status, remains, t, t).lastInsertRowid);
}
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
const refillRows = (orderId) => db.prepare('SELECT status, provider_refill_id, provider_status, reason FROM order_refill_requests WHERE order_id=? ORDER BY id').all(orderId);
const latestRefill = (orderId) => refillRows(orderId).at(-1);
const resetSupplier = () => { supplierCalls.length = 0; };
const isErr = (code) => (e) => e && e.code === code;
const isRefillErr = (code) => (e) => e instanceof R.RefillError && e.code === code;

function customerRefill(orderId, userId = owner) {
  return R.requestRefill({ db, order: orderRow(orderId), actor: 'customer', userId });
}

// ---- runner -----------------------------------------------------------------
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log(`  PASS  ${name}`); }
  catch (e) { results.push(['FAIL', name]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('Client refill tests (fixture supplier)\n');

// ---- 1. eligibility is computed on the server --------------------------------
await t('[1] completed order on a refill service with an active supplier is eligible', () => {
  const id = makeOrder();
  const e = R.refillEligibility({ db, order: orderRow(id) });
  assert.strictEqual(e.supported, true);
  assert.strictEqual(e.eligible, true);
  assert.strictEqual(e.reason, null);
});

await t('[2] PENDING and IN_PROGRESS orders are supported but not eligible, with a reason', () => {
  for (const status of ['PENDING', 'IN_PROGRESS', 'CANCELED']) {
    const e = R.refillEligibility({ db, order: orderRow(makeOrder({ status })) });
    assert.strictEqual(e.supported, true, status);
    assert.strictEqual(e.eligible, false, status);
    assert.match(e.reason, /completed or partly delivered/, status);
  }
});

await t('[3] PARTIAL orders are eligible', () => {
  assert.strictEqual(R.refillEligibility({ db, order: orderRow(makeOrder({ status: 'PARTIAL', remains: 10 })) }).eligible, true);
});

await t('[4] service without refill support: never eligible, not offered', () => {
  const e = R.refillEligibility({ db, order: orderRow(makeOrder({ serviceId: svcNoRefill })) });
  assert.strictEqual(e.supported, false);
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /does not offer refill/);
});

await t('[5] order without a supplier order id is not eligible (no internal-id fallback)', () => {
  const e = R.refillEligibility({ db, order: orderRow(makeOrder({ providerOrderId: null })) });
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /no supplier reference/);
});

await t('[6] inactive supplier makes the order not eligible', () => {
  const e = R.refillEligibility({ db, order: orderRow(makeOrder({ serviceId: svcInactive, providerId: inactiveProv })) });
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /unavailable right now/);
});

await t('[7] eligibility summary never contains supplier ids, keys or API URLs', () => {
  const id = makeOrder();
  const text = JSON.stringify(R.refillEligibility({ db, order: orderRow(id) }));
  assert.ok(!text.includes(API_KEY));
  assert.ok(!text.includes('supplier.invalid'));
  assert.ok(!/SUP-\d+/.test(text));
});

// ---- 2. supplier contract: refill via the real smmpost adapter ----------------
await t('[8] success: sends action=refill with the SUPPLIER order id and stores the refill id', async () => {
  resetSupplier();
  const id = makeOrder({ providerOrderId: 'SUP-REAL-1' });
  supplierReply = () => json({ refill: 'R-42' });
  const out = await customerRefill(id);
  assert.deepStrictEqual(out, { ok: true, status: 'ACCEPTED' });
  assert.strictEqual(supplierCalls.length, 1);
  assert.strictEqual(supplierCalls[0].action, 'refill');
  assert.strictEqual(supplierCalls[0].order, 'SUP-REAL-1', 'must use the supplier order id, not order_ref or the internal id');
  assert.strictEqual(supplierCalls[0].key, API_KEY, 'key is sent in the POST body only');
  assert.strictEqual(latestRefill(id).status, 'ACCEPTED');
  assert.strictEqual(latestRefill(id).provider_refill_id, 'R-42');
});

await t('[9] success leaves the order status, remains and price unchanged', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-KEEP', status: 'PARTIAL', remains: 40 });
  const before = orderRow(id);
  supplierReply = () => json({ refill: 'R-43' });
  await customerRefill(id);
  const after = orderRow(id);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.remains, before.remains);
  assert.strictEqual(after.price_inr, before.price_inr);
});

await t('[10] supplier refusal ({error}) is REJECTED; nothing changes; message has no supplier text', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-BAD' });
  supplierReply = () => json({ error: 'Incorrect order ID' }, 400);
  await assert.rejects(customerRefill(id), (e) => {
    assert.strictEqual(e.code, 'REFILL_REJECTED');
    assert.strictEqual(e.http, 409);
    assert.ok(!e.message.includes('Incorrect order ID'), 'supplier text must not reach the customer');
    return true;
  });
  assert.strictEqual(latestRefill(id).status, 'REJECTED');
  assert.strictEqual(latestRefill(id).provider_refill_id, null);
});

await t('[11] supplier error text containing the API key is never echoed', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-KEYLEAK' });
  supplierReply = () => json({ error: `bad key ${API_KEY}` }, 400);
  await assert.rejects(customerRefill(id), (e) => {
    assert.ok(!e.message.includes(API_KEY));
    return e.code === 'REFILL_REJECTED';
  });
});

await t('[12] HTTP 429 is a refusal (rate_limited), not an unknown outcome', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-429' });
  supplierReply = () => ({ status: 429, text: 'Too many requests' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_REJECTED'));
  assert.strictEqual(latestRefill(id).status, 'REJECTED');
  assert.strictEqual(latestRefill(id).reason, 'rate_limited');
});

await t('[13] timeout / network failure is AMBIGUOUS, reported as unconfirmed, and blocks retries', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-TIMEOUT' });
  supplierReply = () => { throw new Error('The operation was aborted'); };
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(latestRefill(id).status, 'AMBIGUOUS');
  supplierReply = () => json({ refill: 'SHOULD-NOT-HAPPEN' });
  const before = supplierCalls.length;
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_ALREADY_REQUESTED'));
  assert.strictEqual(supplierCalls.length, before, 'no second supplier call while AMBIGUOUS');
});

await t('[14] invalid reply with no refill id is AMBIGUOUS (never ACCEPTED)', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-NOID' });
  supplierReply = () => json({ status: 'ok' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(latestRefill(id).status, 'AMBIGUOUS');
});

await t('[15] non-JSON reply is AMBIGUOUS', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-HTML' });
  supplierReply = () => ({ status: 200, text: '<html>maintenance</html>' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(latestRefill(id).status, 'AMBIGUOUS');
});

await t('[16] HTTP 500 is AMBIGUOUS', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-500' });
  supplierReply = () => ({ status: 500, text: 'boom' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_UNCONFIRMED'));
  assert.strictEqual(latestRefill(id).status, 'AMBIGUOUS');
});

// ---- 3. duplicates, concurrency and ownership --------------------------------
await t('[17] second refill after ACCEPTED is blocked before any supplier call', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-DUP' });
  supplierReply = () => json({ refill: 'R-DUP' });
  await customerRefill(id);
  resetSupplier();
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_ALREADY_REQUESTED'));
  assert.strictEqual(supplierCalls.length, 0);
  assert.strictEqual(refillRows(id).length, 1, 'no extra refill row');
});

await t('[18] concurrent clicks send exactly one supplier request', async () => {
  resetSupplier();
  const id = makeOrder({ providerOrderId: 'SUP-RACE' });
  supplierReply = async () => { await new Promise((r) => setTimeout(r, 40)); return json({ refill: 'R-RACE' }); };
  const results2 = await Promise.allSettled([customerRefill(id), customerRefill(id), customerRefill(id)]);
  const ok = results2.filter((r) => r.status === 'fulfilled').length;
  assert.strictEqual(ok, 1, 'exactly one request succeeds');
  assert.strictEqual(supplierCalls.length, 1, 'exactly one supplier call');
  assert.strictEqual(refillRows(id).length, 1, 'exactly one refill row');
});

await t('[19] customer cannot refill another customer\'s order (404, no supplier call)', async () => {
  resetSupplier();
  const id = makeOrder({ providerOrderId: 'SUP-OWN' });
  await assert.rejects(customerRefill(id, stranger), isRefillErr('NOT_FOUND'));
  assert.strictEqual(supplierCalls.length, 0);
  assert.strictEqual(refillRows(id).length, 0);
});

await t('[20] customer refill on a PENDING order is refused server-side (no supplier call)', async () => {
  resetSupplier();
  const id = makeOrder({ status: 'PENDING', providerOrderId: 'SUP-PEND' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_NOT_AVAILABLE'));
  assert.strictEqual(supplierCalls.length, 0);
});

await t('[21] a service without refill is refused server-side (no supplier call)', async () => {
  resetSupplier();
  const id = makeOrder({ serviceId: svcNoRefill, providerId: smmProv, providerOrderId: 'SUP-NR' });
  await assert.rejects(customerRefill(id), isRefillErr('REFILL_NOT_SUPPORTED'));
  assert.strictEqual(supplierCalls.length, 0);
});

await t('[22] after the supplier reports a refill as "Rejected", a new request is allowed', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-RETRY' });
  supplierReply = () => json({ refill: 'R-OLD' });
  await customerRefill(id);
  supplierReply = () => json({ status: 'Rejected' });
  await R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 });
  supplierReply = () => json({ refill: 'R-NEW' });
  const out = await customerRefill(id);
  assert.strictEqual(out.status, 'ACCEPTED');
  assert.strictEqual(refillRows(id).length, 2);
});

// ---- 4. refill status lookup --------------------------------------------------
await t('[23] status lookup sends action=refill_status with the refill id and stores the supplier text', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-STAT' });
  supplierReply = () => json({ refill: 'R-STAT' });
  await customerRefill(id);
  resetSupplier();
  supplierReply = () => json({ status: 'Completed' });
  const out = await R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 });
  assert.strictEqual(out.supplier_status, 'Completed');
  assert.strictEqual(out.cached, false);
  assert.strictEqual(supplierCalls[0].action, 'refill_status');
  assert.strictEqual(supplierCalls[0].refill, 'R-STAT');
  assert.strictEqual(latestRefill(id).provider_status, 'Completed');
});

await t('[24] status checks are cached for the cooldown period (no extra supplier call)', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-COOL' });
  supplierReply = () => json({ refill: 'R-COOL' });
  await customerRefill(id);
  const stamp = Date.now() + 120000;
  supplierReply = () => json({ status: 'Pending' });
  await R.checkRefillStatus({ db, order: orderRow(id), now: stamp });
  resetSupplier();
  const again = await R.checkRefillStatus({ db, order: orderRow(id), now: stamp + 5000 });
  assert.strictEqual(again.cached, true);
  assert.strictEqual(supplierCalls.length, 0);
});

await t('[25] supplier status error is a safe 502; stored status is unchanged', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-STERR' });
  supplierReply = () => json({ refill: 'R-STERR' });
  await customerRefill(id);
  supplierReply = () => json({ error: 'Refill not found' }, 400);
  await assert.rejects(R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 }), (e) => {
    assert.strictEqual(e.code, 'STATUS_UNAVAILABLE');
    assert.strictEqual(e.http, 502);
    assert.ok(!e.message.includes('Refill not found'));
    return true;
  });
  assert.strictEqual(latestRefill(id).provider_status, null);
});

await t('[26] status reply without a status value is treated as unavailable, not as a status', async () => {
  const id = makeOrder({ providerOrderId: 'SUP-NOSTAT' });
  supplierReply = () => json({ refill: 'R-NOSTAT' });
  await customerRefill(id);
  supplierReply = () => json({});
  await assert.rejects(R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 }), isErr('STATUS_UNAVAILABLE'));
});

await t('[27] status check with no accepted refill is refused (no supplier call)', async () => {
  resetSupplier();
  const id = makeOrder({ providerOrderId: 'SUP-NONE' });
  await assert.rejects(R.checkRefillStatus({ db, order: orderRow(id) }), isRefillErr('REFILL_NOT_CHECKABLE'));
  assert.strictEqual(supplierCalls.length, 0);
});

await t('[28] adapter without refill_status reports STATUS_UNSUPPORTED (no invented status)', async () => {
  const id = makeOrder({ serviceId: svcRefillMock, providerId: mockProv, providerOrderId: 'M-1' });
  scripted.refill = async () => ({ refill: 'MOCK-R-28' });
  scripted.refillStatus = undefined;
  await R.requestRefill({ db, order: orderRow(id), actor: 'customer', userId: owner });
  await assert.rejects(R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 }), isRefillErr('STATUS_UNSUPPORTED'));
});

// ---- 5. admin path uses the same guards and never changes the order ----------
await t('[29] admin refill: same guarded path, order status and remains unchanged', async () => {
  const id = makeOrder({ serviceId: svcRefillSmm, providerId: smmProv, status: 'COMPLETED', providerOrderId: 'SUP-ADM' });
  supplierReply = () => json({ refill: 'R-ADM' });
  const before = orderRow(id);
  const out = await orderRouter.refillOrder({ admin: { id: 1, email: 'a@test.dev' }, orderId: id });
  assert.deepStrictEqual(out, { ok: true, status: 'ACCEPTED' });
  assert.strictEqual(orderRow(id).status, before.status);
  assert.strictEqual(orderRow(id).remains, before.remains);
  assert.strictEqual(latestRefill(id).provider_refill_id, 'R-ADM');
});

await t('[30] admin refill on a service without refill returns NO_REFILL (400 mapping)', async () => {
  const id = makeOrder({ serviceId: svcNoRefill, providerId: smmProv, providerOrderId: 'SUP-ADM-NR' });
  await assert.rejects(orderRouter.refillOrder({ admin: { id: 1 }, orderId: id }), (e) => {
    assert.strictEqual(e.code, 'NO_REFILL');
    return true;
  });
});

await t('[31] admin refill is blocked while a refill is AMBIGUOUS, with a 409 mapping', async () => {
  const id = makeOrder({ serviceId: svcRefillSmm, providerId: smmProv, providerOrderId: 'SUP-ADM-AMB' });
  supplierReply = () => json({ status: 'no id' });
  await assert.rejects(orderRouter.refillOrder({ admin: { id: 1 }, orderId: id }), (e) => e.code === 'PROVIDER_ERROR' && e.http === 502);
  await assert.rejects(orderRouter.refillOrder({ admin: { id: 1 }, orderId: id }), (e) => e.http === 409);
});

await t('[32] admin refill of a missing order returns 404 mapping', async () => {
  await assert.rejects(orderRouter.refillOrder({ admin: { id: 1 }, orderId: 987654 }), isErr('404'));
});

await t('[32b] admin refill on a PENDING order is refused with 409 and makes zero supplier calls', async () => {
  resetSupplier();
  const id = makeOrder({ serviceId: svcRefillSmm, providerId: smmProv, status: 'PENDING', providerOrderId: 'SUP-ADM-PEND' });
  await assert.rejects(orderRouter.refillOrder({ admin: { id: 1 }, orderId: id }), (e) => e.http === 409);
  assert.strictEqual(supplierCalls.length, 0);
  assert.strictEqual(latestRefill(id), undefined);
});

await t("[33a] per-user eligibility map covers only that customer\x27s orders and never exposes ids", () => {
  const mine = makeOrder({ userId: owner, providerOrderId: "SUP-MAP" });
  const theirs = makeOrder({ userId: stranger, providerOrderId: "SUP-THEIRS" });
  const map = R.refillSummariesForUser(db, owner);
  assert.ok(map.has(mine), "owner order present");
  assert.ok(!map.has(theirs), "stranger order absent");
  assert.strictEqual(map.get(mine).eligible, true);
  assert.ok(!JSON.stringify([...map.values()]).includes("SUP-MAP"), "supplier id not in summaries");
});

// ---- 5b. gate, stale claims, admin review ------------------------------------
const insertRow = (orderId, status, createdAt) => db.prepare(
  "INSERT INTO order_refill_requests (order_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
).run(orderId, owner, status, createdAt, createdAt);
const MIN = 60 * 1000;

await t("[35b] REFILL_ENABLED off: no supplier call on refill or status; eligibility says disabled", async () => {
  const id = makeOrder({ providerOrderId: "SUP-GATE" });
  resetSupplier();
  const prev = process.env.REFILL_ENABLED;
  delete process.env.REFILL_ENABLED;
  try {
    await assert.rejects(customerRefill(id), isRefillErr("REFILL_DISABLED"));
    assert.strictEqual(R.refillEligibility({ db, order: orderRow(id) }).eligible, false);
    assert.match(R.refillEligibility({ db, order: orderRow(id) }).reason, /not enabled/);
    await assert.rejects(R.checkRefillStatus({ db, order: orderRow(id) }), isRefillErr("REFILL_DISABLED"));
    assert.strictEqual(supplierCalls.length, 0, "the gate blocks every supplier call");
  } finally { process.env.REFILL_ENABLED = prev; }
});

await t("[36] abandoned REQUESTED claim becomes AMBIGUOUS and is never resubmitted automatically", async () => {
  const id = makeOrder({ providerOrderId: "SUP-STALE" });
  insertRow(id, "REQUESTED", Date.now() - 20 * MIN);
  resetSupplier();
  supplierReply = () => json({ refill: "SHOULD-NOT-SEND" });
  await assert.rejects(customerRefill(id), isRefillErr("REFILL_ALREADY_REQUESTED"));
  assert.strictEqual(supplierCalls.length, 0, "no supplier call for an abandoned claim");
  assert.strictEqual(latestRefill(id).status, "AMBIGUOUS");
  assert.strictEqual(latestRefill(id).reason, "stale_claim");
  // Recovery does not reopen the order for retries either.
  await assert.rejects(customerRefill(id), isRefillErr("REFILL_ALREADY_REQUESTED"));
  assert.strictEqual(supplierCalls.length, 0);
});

await t("[37] a fresh REQUESTED claim (live call) is not swept", async () => {
  const id = makeOrder({ providerOrderId: "SUP-LIVE" });
  insertRow(id, "REQUESTED", Date.now() - 1 * MIN);
  R.sweepStaleClaims(db, Date.now());
  assert.strictEqual(latestRefill(id).status, "REQUESTED");
});

await t("[38] admin review \"accepted\" with the supplier refill id; status can then be checked", async () => {
  const id = makeOrder({ providerOrderId: "SUP-REV-A" });
  insertRow(id, "AMBIGUOUS", Date.now());
  const out = R.resolveRefillReview({ db, orderId: id, adminId: 1, decision: "accepted", refillId: "R-REVIEW-1", note: "Panel shows refill R-REVIEW-1" });
  assert.deepStrictEqual(out, { ok: true, status: "ACCEPTED" });
  assert.strictEqual(latestRefill(id).provider_refill_id, "R-REVIEW-1");
  resetSupplier();
  supplierReply = () => json({ status: "Pending" });
  const st = await R.checkRefillStatus({ db, order: orderRow(id), now: Date.now() + 120000 });
  assert.strictEqual(st.supplier_status, "Pending");
  assert.strictEqual(supplierCalls[0].refill, "R-REVIEW-1");
});

await t("[39] admin review \"not_accepted\" lets the customer request again", async () => {
  const id = makeOrder({ providerOrderId: "SUP-REV-N" });
  insertRow(id, "AMBIGUOUS", Date.now());
  R.resolveRefillReview({ db, orderId: id, adminId: 1, decision: "not_accepted", note: "Supplier shows no refill for this order" });
  assert.strictEqual(latestRefill(id).status, "REJECTED");
  supplierReply = () => json({ refill: "R-AFTER-REVIEW" });
  const out = await customerRefill(id);
  assert.strictEqual(out.status, "ACCEPTED");
});

await t("[40] review input is validated and cannot touch orders that are not in review", () => {
  const id = makeOrder({ providerOrderId: "SUP-REV-V" });
  insertRow(id, "AMBIGUOUS", Date.now());
  assert.throws(() => R.resolveRefillReview({ db, orderId: id, adminId: 1, decision: "bogus", note: "valid note" }), isRefillErr("BAD_DECISION"));
  assert.throws(() => R.resolveRefillReview({ db, orderId: id, adminId: 1, decision: "accepted", note: "valid note" }), isRefillErr("BAD_REFILL_ID"));
  assert.throws(() => R.resolveRefillReview({ db, orderId: id, adminId: 1, decision: "not_accepted", note: "x" }), isRefillErr("BAD_NOTE"));
  assert.strictEqual(latestRefill(id).status, "AMBIGUOUS", "failed validation changes nothing");
  const other = makeOrder({ providerOrderId: "SUP-REV-O" });
  assert.throws(() => R.resolveRefillReview({ db, orderId: other, adminId: 1, decision: "not_accepted", note: "no refill here" }), isRefillErr("NOT_IN_REVIEW"));
  const accepted = makeOrder({ providerOrderId: "SUP-REV-OK" });
  insertRow(accepted, "ACCEPTED", Date.now());
  assert.throws(() => R.resolveRefillReview({ db, orderId: accepted, adminId: 1, decision: "not_accepted", note: "should not apply" }), isRefillErr("NOT_IN_REVIEW"));
  assert.strictEqual(latestRefill(accepted).status, "ACCEPTED");
});

await t("[41] customer sees a review message for an ambiguous refill, not a retry button", () => {
  const id = makeOrder({ providerOrderId: "SUP-REV-M" });
  insertRow(id, "AMBIGUOUS", Date.now());
  const e = R.refillEligibility({ db, order: orderRow(id) });
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /being reviewed/);
});

// ---- 6. static contract of the customer page ----------------------------------
await t('[33] Orders page shows the button only from server eligibility and disables it while busy', () => {
  const src = readFileSync(path.join(ROOT, 'client', 'src', 'pages', 'client', 'Orders.jsx'), 'utf8');
  assert.match(src, /refill\.eligible && \(/, 'button must be gated on server eligibility');
  assert.match(src, /disabled=\{busy !== null\}/, 'button must be disabled while a request runs');
  assert.match(src, /post\(`\/api\/orders\/\$\{o\.id\}\/refill`/, 'submits to the customer refill endpoint');
  assert.match(src, /role="status"/, 'result messages are announced');
  assert.doesNotMatch(src, /provider_order_id|provider_refill_id|api_key|api_url/, 'page must not reference supplier fields');
});

await t('[34] refill styles keep touch targets and wrap long supplier text', () => {
  const css = readFileSync(path.join(ROOT, 'client', 'src', 'styles', 'global.css'), 'utf8');
  assert.match(css, /\.refill-btn \{[^}]*min-height: 40px/);
  assert.match(css, /\.refill-note \{[^}]*overflow-wrap: anywhere/);
});

// ---- summary ----------------------------------------------------------------
globalThis.fetch = realFetch;
const passed = results.filter((r) => r[0] === 'PASS').length;
const failed = results.filter((r) => r[0] === 'FAIL').length;
assert.strictEqual(unexpectedFetch, 0, `unexpected network calls: ${unexpectedFetch}`);
console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
if (failed) process.exit(1);
