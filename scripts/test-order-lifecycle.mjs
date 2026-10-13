// ---------------------------------------------------------------------------
// Order lifecycle regression tests (Task 2: supplier balance & order reliability).
// MOCKED suppliers only: no network, no real supplier orders, no money moved
// outside a throwaway SQLite file.
//   run: node scripts/test-order-lifecycle.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'order-lifecycle-'));
const SECRET = 'SUPPLIER-SECRET-KEY-7f3a';
process.env.DB_FILE = path.join(TEST_DIR, 'lifecycle.db');
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
process.env.ADMIN_EMAIL_1 = 'lifecycle-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'lifecycle-admin-pass-1';
process.env.SESSION_SECRET = 'lifecycle-session-secret';

// Any real network attempt is a test failure.
let unexpectedFetch = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const { getDb } = await import(path.join(ROOT, 'server', 'db.js'));
const { registerProviderAdapter } = await import(path.join(ROOT, 'server', 'lib/provider.js'));
const orderRouter = await import(path.join(ROOT, 'server', 'lib/orderRouter.js'));
const L = await import(path.join(ROOT, 'server', 'lib/orderLifecycle.js'));
const { computePricing } = await import(path.join(ROOT, 'server', 'lib/money.js'));
const smmpostFactory = (await import(path.join(ROOT, 'server', 'lib/providers/smmpost.js'))).default;
const { orderWithService, userOrders } = orderRouter;

const db = getDb();
if (db.isPg) throw new Error('test-order-lifecycle must run on the temporary SQLite file');

// ---- mock supplier ----------------------------------------------------------
const defaultBehaviour = () => ({ id: `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'PENDING', charge: 1, currency: 'USD' });
let behaviour = defaultBehaviour;
let supplierCalls = 0;
registerProviderAdapter('mockprov', () => ({
  kind: 'mock',
  async placeOrder(args) { supplierCalls++; return behaviour(args); },
  async cancel() { return {}; },
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = (category = 'provider_rejected', msg = 'Supplier refused the order') =>
  Object.assign(new Error(msg), { kind: 'rejected', category });
const unknownOutcome = (category = 'ambiguous', msg = 'supplier outcome unknown') =>
  Object.assign(new Error(msg), { kind: 'unknown', category });

// ---- fixtures ---------------------------------------------------------------
db.prepare("INSERT INTO categories (name, slug) VALUES ('Lifecycle', 'lifecycle-test')").run();
const CATEGORY_ID = db.prepare("SELECT id FROM categories WHERE slug='lifecycle-test'").get().id;
const admin = { id: 1, email: 'lifecycle-admin@test.dev', role: 'admin' };
const notAdmin = { id: 2, email: 'customer@test.dev', role: 'client' };
const impostor = { id: 3, email: 'impostor@test.dev', role: 'admin' };

function makeProvider({ active = 1, name = 'Mock Supplier', adapter = 'mockprov', apiKey = SECRET } = {}) {
  const now = Date.now();
  const id = Number(db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, balance, currency, markup_type, markup_value, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(name, adapter, 'https://supplier.invalid/api', apiKey, active, 100000, 'USD', 'percent', 25, now, now).lastInsertRowid);
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id);
}
function makeService(provider, { rate = 10, adminRate = 12.5, min = 10, max = 1000, status = 1 } = {}) {
  const id = Number(db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate, type, min, max, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,'Default',?,?,0,0,?,?)`
  ).run(CATEGORY_ID, provider.id, `svc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, 'Lifecycle Service',
    rate, adminRate, min, max, status, Date.now()).lastInsertRowid);
  return db.prepare('SELECT * FROM services WHERE id=?').get(id);
}
let userSeq = 0;
function makeUser(balance) {
  const email = `lc-user-${++userSeq}-${process.pid}@test.dev`;
  db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?,'client','LC',?,0,'active',0,?)`
  ).run(email, 'x', balance, Date.now());
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}
const U = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const wallet = (id) => Number(U(id).wallet_balance);
const ledger = (id) => Number(db.prepare('SELECT COALESCE(SUM(amount_inr),0) s FROM transactions WHERE user_id=?').get(id).s);
const count = (sql, ...args) => Number(db.prepare(sql).get(...args).c);
const refundRows = (id) => count("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='refund'", id);
const orderBy = (sqlWhere, ...args) => db.prepare(`SELECT * FROM orders WHERE ${sqlWhere} ORDER BY id DESC LIMIT 1`).get(...args);
const finalFor = (service, qty = service.min, couponCode = null) =>
  orderRouter.quoteOrder({ serviceId: service.id, quantity: qty, couponCode, noProfit: false }).final;
const place = (user, service, link, extra = {}) =>
  orderRouter.placeOrder({ user, serviceId: service.id, link, quantity: service.min, ...extra });
async function outcome(p) {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; }
}
const alertsLogged = () => db.prepare("SELECT action, detail FROM security_logs WHERE action LIKE 'supplier_%'").all();

// ---- runner -----------------------------------------------------------------
let pass = 0;
let fail = 0;
async function t(name, fn) {
  supplierCalls = 0;
  behaviour = defaultBehaviour;
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}

console.log('Order lifecycle tests (mocked suppliers, throwaway SQLite)');

// 1 ──────────────────────────────────────────────────────────────────────────
await t('[1] provider-confirmed acceptance: one debit, supplier id recorded, no refund', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = () => ({ id: 'ACC-1', status: 'PENDING', charge: 5, currency: 'USD' });
  const final = finalFor(s);
  const order = await place(U(u.id), s, 'https://instagram.com/acc-1');
  assert.strictEqual(order.status, 'PENDING', 'accepted orders move to the supplier status');
  assert.strictEqual(wallet(u.id), 500000 - final, 'exactly one debit of the final price');
  assert.strictEqual(ledger(u.id), -final, 'ledger holds exactly one order debit');
  assert.strictEqual(count("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'", u.id), 1);
  assert.strictEqual(orderBy('user_id=?', u.id).provider_order_id, 'ACC-1');
  assert.strictEqual(supplierCalls, 1, 'the supplier is called exactly once');
});

// 2 ──────────────────────────────────────────────────────────────────────────
await t('[2] definitive rejection: refunded exactly once, order REJECTED, never accepted', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = () => { throw refused('provider_rejected'); };
  const res = await outcome(place(U(u.id), s, 'https://instagram.com/rej-1'));
  assert.ok(!res.ok && res.error.code === 'PROVIDER_ERROR', 'the customer gets the generic provider error');
  assert.strictEqual(wallet(u.id), 500000, 'the balance is restored');
  assert.strictEqual(ledger(u.id), 0, 'debit and refund net to zero');
  assert.strictEqual(refundRows(u.id), 1, 'exactly one refund row');
  const row = orderBy('user_id=?', u.id);
  assert.strictEqual(row.status, 'REJECTED');
  assert.strictEqual(row.provider_order_id, null, 'a refused order never gets a supplier id');
  // Replaying the settlement must not refund again.
  const again = L.settleRejected({ db, orderId: row.id });
  assert.strictEqual(again.refunded, false, 'a second settlement refunds nothing');
  assert.strictEqual(wallet(u.id), 500000, 'balance unchanged by the replay');
  assert.strictEqual(refundRows(u.id), 1, 'still exactly one refund row');
  // Admin reconcile cannot refund a REJECTED order either.
  assert.throws(() => L.reconcileOrder({ db, admin, orderId: row.id, action: 'reject' }),
    (e) => e.code === 'NOT_AMBIGUOUS');
});

// 3 ──────────────────────────────────────────────────────────────────────────
await t('[3] supplier insufficient balance: safe customer message, private alert, no leak', async () => {
  const p = makeProvider({ name: 'Funds Supplier' }); const s = makeService(p);
  const u = makeUser(500000);
  const rawSupplierText = 'Not enough balance on SUPPLIER-ACCOUNT-99';
  behaviour = () => { throw refused('insufficient_supplier_funds', rawSupplierText); };
  const res = await outcome(place(U(u.id), s, 'https://instagram.com/funds-1'));
  assert.ok(!res.ok && res.error.code === 'PROVIDER_ERROR');
  assert.ok(!res.error.message.includes('SUPPLIER-ACCOUNT'), 'the customer message carries no supplier text');
  assert.ok(res.error.message.includes('not charged'), 'the customer is told the truth: not charged');
  assert.strictEqual(wallet(u.id), 500000, 'refunded');
  const logged = alertsLogged().filter((a) => a.action === 'supplier_insufficient_funds');
  assert.strictEqual(logged.length, 1, 'one private admin alert for the confirmed insufficient balance');
  assert.ok(logged[0].detail.includes('insufficient_supplier_funds'));
  assert.ok(!logged[0].detail.includes('SUPPLIER-ACCOUNT'), 'the alert carries only a fixed category');
  assert.ok(!String(orderBy('user_id=?', u.id).status).includes('ACCOUNT'));
  assert.ok(!String(db.prepare('SELECT last_error FROM providers WHERE id=?').get(p.id).last_error).includes('SUPPLIER-ACCOUNT'),
    'the stored provider error is a category, not supplier text');
  // A customer whose own balance is short is refused before the supplier is called.
  const poor = makeUser(1);
  const short = await outcome(place(U(poor.id), s, 'https://instagram.com/funds-poor'));
  assert.ok(!short.ok && short.error.code === 'INSUFFICIENT_BALANCE');
  assert.strictEqual(supplierCalls, 1, 'the short customer never reached the supplier');
});

// 4 ──────────────────────────────────────────────────────────────────────────
await t('[4] timeout after the supplier may have accepted: held AMBIGUOUS, not refunded, not retried', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  const final = finalFor(s);
  behaviour = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  const res = await outcome(place(U(u.id), s, 'https://instagram.com/timeout-1'));
  assert.ok(!res.ok && res.error.code === 'VERIFYING', 'the customer is told the order is being verified');
  assert.ok(!/charged|refund|rejected/i.test(res.error.message), 'no false "rejected" or "not charged" claim');
  const row = orderBy('user_id=?', u.id);
  assert.strictEqual(row.status, 'AMBIGUOUS');
  assert.strictEqual(wallet(u.id), 500000 - final, 'the reservation stays held');
  assert.strictEqual(refundRows(u.id), 0, 'an ambiguous outcome is never refunded automatically');
  assert.strictEqual(supplierCalls, 1);
  // A customer retry while held is refused and never reaches the supplier.
  const retry = await outcome(place(U(u.id), s, 'https://instagram.com/timeout-1'));
  assert.ok(!retry.ok && retry.error.code === 'DUPLICATE_ORDER', 'a held identical order cannot be placed again');
  assert.strictEqual(supplierCalls, 1, 'no duplicate supplier order');
  // The stale sweep only touches SUBMITTING, never AMBIGUOUS.
  assert.strictEqual(L.sweepStaleSubmitting({ db, now: Date.now() + 60 * 60_000 }), 0);
  assert.strictEqual(orderBy('user_id=?', u.id).status, 'AMBIGUOUS');
  // Admin reconciles with supplier evidence: accepted, no second charge.
  L.reconcileOrder({ db, admin, orderId: row.id, action: 'accept', providerOrderId: 'LATE-1' });
  const after = orderBy('user_id=?', u.id);
  assert.strictEqual(after.status, 'PENDING');
  assert.strictEqual(after.provider_order_id, 'LATE-1');
  assert.strictEqual(wallet(u.id), 500000 - final, 'accepting never charges again');
});

await t('[4b] a reservation stranded by a stopped process becomes AMBIGUOUS, never refunded', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  const pricing = computePricing({ qty: s.min, adminRate: s.admin_rate, baseRate: s.provider_rate, noProfit: false, coupon: null });
  const reserved = L.reserveOrder({ db, user: U(u.id), service: s, provider: p, quantity: s.min,
    link: 'https://instagram.com/stranded', pricing, coupon: null, now: Date.now() - 10 * 60_000 });
  assert.strictEqual(orderBy('id=?', reserved.orderId).status, 'SUBMITTING');
  assert.strictEqual(L.sweepStaleSubmitting({ db }), 1);
  const row = orderBy('id=?', reserved.orderId);
  assert.strictEqual(row.status, 'AMBIGUOUS');
  assert.strictEqual(wallet(u.id), 500000 - pricing.final, 'no automatic refund for a stranded reservation');
  assert.strictEqual(refundRows(u.id), 0);
});

// 5 ──────────────────────────────────────────────────────────────────────────
await t('[5] provider 5xx and malformed replies: never accepted, never refunded automatically', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = () => { throw unknownOutcome('http_5xx', 'HTTP 503'); };
  const a = await outcome(place(U(u.id), s, 'https://instagram.com/5xx-1'));
  assert.ok(!a.ok && a.error.code === 'VERIFYING');
  assert.strictEqual(orderBy('link=?', 'https://instagram.com/5xx-1').status, 'AMBIGUOUS');

  behaviour = () => ({ status: 'PENDING' }); // 200 reply with no order id
  const b = await outcome(place(U(u.id), s, 'https://instagram.com/malformed-1'));
  assert.ok(!b.ok && b.error.code === 'VERIFYING', 'a reply without an order id is not treated as accepted');
  const rowB = orderBy('link=?', 'https://instagram.com/malformed-1');
  assert.strictEqual(rowB.status, 'AMBIGUOUS');
  assert.strictEqual(rowB.provider_order_id, null, 'nothing recorded as the supplier id');
  assert.strictEqual(refundRows(u.id), 0);
});

await t('[5b] the smmpost adapter classifies 5xx, non-JSON and transport failures as unknown outcomes', async () => {
  const adapter = smmpostFactory({ api_url: 'https://supplier.invalid/api', api_key: SECRET, name: 'SMM', currency: 'USD' });
  const reply = (body, status = 200) => { globalThis.fetch = async () => new Response(body, { status }); };
  try {
    reply(JSON.stringify({ error: 'Internal failure' }), 503);
    const e1 = await adapter.placeOrder({ service: '1', link: 'x', quantity: 10 }).catch((e) => e);
    assert.strictEqual(e1.kind, 'unknown'); assert.strictEqual(e1.category, 'http_5xx');

    reply('<html>gateway</html>', 200);
    const e2 = await adapter.placeOrder({ service: '1', link: 'x', quantity: 10 }).catch((e) => e);
    assert.strictEqual(e2.kind, 'unknown'); assert.strictEqual(e2.category, 'non_json');

    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    const e3 = await adapter.placeOrder({ service: '1', link: 'x', quantity: 10 }).catch((e) => e);
    assert.strictEqual(e3.kind, 'unknown'); assert.strictEqual(e3.category, 'network');
  } finally {
    globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };
  }
});

// 6 ──────────────────────────────────────────────────────────────────────────
await t('[6] duplicate and concurrent submissions: one supplier order, one debit', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = async () => { await sleep(30); return { id: `CONC-${Math.random().toString(36).slice(2, 8)}`, status: 'PENDING' }; };
  const link = 'https://instagram.com/conc-same';
  const results = await Promise.allSettled([place(U(u.id), s, link), place(U(u.id), s, link)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactly one identical order may proceed');
  assert.strictEqual(bad[0].reason.code, 'DUPLICATE_ORDER');
  assert.strictEqual(supplierCalls, 1, 'one supplier order for two identical submissions');
  assert.strictEqual(count("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'", u.id), 1);
});

await t('[6b] concurrent different orders on a balance for one: exactly one reaches the supplier', async () => {
  const p = makeProvider(); const s = makeService(p);
  const final = finalFor(s);
  const u = makeUser(final); // balance covers exactly one order
  behaviour = async () => { await sleep(20); return { id: `ONE-${Math.random().toString(36).slice(2, 8)}`, status: 'PENDING' }; };
  // Both snapshots show the full balance (stale session view).
  const snapshotA = U(u.id); const snapshotB = U(u.id);
  const results = await Promise.allSettled([
    orderRouter.placeOrder({ user: snapshotA, serviceId: s.id, link: 'https://instagram.com/one-a', quantity: s.min }),
    orderRouter.placeOrder({ user: snapshotB, serviceId: s.id, link: 'https://instagram.com/one-b', quantity: s.min }),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(results.find((r) => r.status === 'rejected').reason.code, 'INSUFFICIENT_BALANCE');
  assert.strictEqual(supplierCalls, 1, 'the supplier was asked for one order, not two');
  assert.strictEqual(wallet(u.id), 0, 'never negative');
});

// 7 ──────────────────────────────────────────────────────────────────────────
await t('[7] duplicate supplier order ids: the second order is held, the first is untouched', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  const final = finalFor(s);
  behaviour = () => ({ id: 'DUP-1', status: 'PENDING' });
  const first = await place(U(u.id), s, 'https://instagram.com/dup-first');
  assert.strictEqual(first.status, 'PENDING');
  const second = await outcome(place(U(u.id), s, 'https://instagram.com/dup-second'));
  assert.ok(!second.ok && second.error.code === 'VERIFYING', 'a reused supplier id is held, not accepted');
  const heldRow = orderBy('link=?', 'https://instagram.com/dup-second');
  assert.strictEqual(heldRow.status, 'AMBIGUOUS');
  assert.strictEqual(heldRow.provider_order_id, null, 'the reused id is not recorded on the second order');
  assert.strictEqual(count('SELECT COUNT(*) c FROM orders WHERE provider_order_id=?', 'DUP-1'), 1, 'one order owns the supplier id');
  assert.strictEqual(orderBy('link=?', 'https://instagram.com/dup-first').status, 'PENDING', 'the first order is untouched');
  assert.strictEqual(wallet(u.id), 500000 - 2 * final, 'both debits remain held; no silent refund');
  assert.strictEqual(refundRows(u.id), 0);
});

// 8 ──────────────────────────────────────────────────────────────────────────
await t('[8] coupon reservation and release: released exactly once on rejection, usable again', async () => {
  const p = makeProvider(); const s = makeService(p);
  const now = Date.now();
  db.prepare(`INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
              VALUES ('LIFE1','percent',10,0,NULL,NULL,1,1,0,?)`).run(now);
  const coupon = () => db.prepare("SELECT * FROM coupons WHERE code='LIFE1'").get();
  const u = makeUser(500000);
  behaviour = () => { throw refused('provider_rejected'); };
  await outcome(place(U(u.id), s, 'https://instagram.com/coupon-a', { couponCode: 'LIFE1' }));
  assert.strictEqual(coupon().used_count, 0, 'the rejected order released its coupon use');
  assert.strictEqual(count('SELECT COUNT(*) c FROM coupon_uses WHERE user_id=?', u.id), 0, 'no coupon use row survives the rejection');
  assert.strictEqual(wallet(u.id), 500000, 'the discounted reservation was refunded exactly');
  // Settling the same rejection again must not release a second time.
  const rejected = orderBy('link=?', 'https://instagram.com/coupon-a');
  L.settleRejected({ db, orderId: rejected.id });
  assert.strictEqual(coupon().used_count, 0, 'a replayed release cannot drive the count negative');
  // The released use is available again.
  behaviour = defaultBehaviour;
  const b = await place(U(u.id), s, 'https://instagram.com/coupon-b', { couponCode: 'LIFE1' });
  assert.strictEqual(b.status, 'PENDING');
  assert.strictEqual(coupon().used_count, 1, 'the accepted order holds the single use');
  assert.strictEqual(count('SELECT COUNT(*) c FROM coupon_uses WHERE order_id=?', b.id), 1);
  // A third order with the coupon is refused before any supplier call.
  const before = supplierCalls;
  const c = await outcome(place(U(u.id), s, 'https://instagram.com/coupon-c', { couponCode: 'LIFE1' }));
  assert.ok(!c.ok && c.error.code === 'BAD_COUPON');
  assert.strictEqual(supplierCalls, before, 'no supplier call for an exhausted coupon');
});

// 9 ──────────────────────────────────────────────────────────────────────────
await t('[9] ledger consistency across mixed outcomes and repeated rollback attempts', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(900000);
  const start = 900000;
  behaviour = () => ({ id: `LED-${Math.random().toString(36).slice(2, 8)}`, status: 'PENDING' });
  await place(U(u.id), s, 'https://instagram.com/led-acc');
  behaviour = () => { throw refused(); };
  await outcome(place(U(u.id), s, 'https://instagram.com/led-rej'));
  behaviour = () => { throw unknownOutcome('http_5xx'); };
  await outcome(place(U(u.id), s, 'https://instagram.com/led-amb'));
  assert.strictEqual(wallet(u.id), start + ledger(u.id), 'the ledger sums to the balance (no drift)');

  // Repeated rollback: a coupon whose usage was spent between check and write.
  // reserveOrder must roll back every write each time, leaving no trace.
  const exhausted = db.prepare(`INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
    VALUES ('SPENT1','percent',10,0,NULL,NULL,1,1,1,?)`).run(Date.now());
  const staleCoupon = { id: Number(exhausted.lastInsertRowid), code: 'SPENT1', type: 'percent', value: 10, min_order_inr: 0 };
  const pricing = computePricing({ qty: s.min, adminRate: s.admin_rate, baseRate: s.provider_rate, noProfit: false, coupon: staleCoupon });
  const walletBefore = wallet(u.id);
  const ledgerBefore = ledger(u.id);
  const ordersBefore = count('SELECT COUNT(*) c FROM orders WHERE user_id=?', u.id);
  for (let i = 0; i < 3; i++) {
    assert.throws(() => L.reserveOrder({ db, user: U(u.id), service: s, provider: p, quantity: s.min,
      link: `https://instagram.com/spent-${i}`, pricing, coupon: staleCoupon, now: Date.now() }),
    (e) => e.code === 'BAD_COUPON');
  }
  assert.strictEqual(wallet(u.id), walletBefore, 'rolled-back debits leave the balance unchanged');
  assert.strictEqual(ledger(u.id), ledgerBefore, 'rolled-back ledger rows leave no trace');
  assert.strictEqual(count('SELECT COUNT(*) c FROM orders WHERE user_id=?', u.id), ordersBefore, 'no rolled-back order row');
  // The connection is not left inside a transaction: a normal order still works.
  behaviour = defaultBehaviour;
  const ok = await place(U(u.id), s, 'https://instagram.com/after-rollback');
  assert.strictEqual(ok.status, 'PENDING');
});

// 10 ─────────────────────────────────────────────────────────────────────────
await t('[10] admin-only: only an authenticated admin may reconcile; customers see no supplier ids', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = () => { throw unknownOutcome('timeout'); };
  await outcome(place(U(u.id), s, 'https://instagram.com/authz-1'));
  const row = orderBy('user_id=?', u.id);
  assert.strictEqual(row.status, 'AMBIGUOUS');

  assert.throws(() => L.reconcileOrder({ db, admin: undefined, orderId: row.id, action: 'reject' }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => L.reconcileOrder({ db, admin: notAdmin, orderId: row.id, action: 'reject' }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => L.reconcileOrder({ db, admin: impostor, orderId: row.id, action: 'reject' }), (e) => e.code === 'FORBIDDEN',
    'a role claim without a configured admin email is refused');
  assert.strictEqual(orderBy('id=?', row.id).status, 'AMBIGUOUS', 'refused calls change nothing');
  assert.strictEqual(refundRows(u.id), 0);

  // Customer-facing projections never contain the supplier order id or provider id.
  L.reconcileOrder({ db, admin, orderId: row.id, action: 'accept', providerOrderId: 'VIS-SECRET-ID-42' });
  const masked = orderWithService(db, row.id);
  assert.ok(masked && !('provider_order_id' in masked) && !('provider_id' in masked), 'order detail hides supplier identifiers');
  const history = userOrders(db, u.id);
  assert.ok(history.every((o) => !('provider_order_id' in o)), 'order history hides supplier identifiers');
  assert.ok(!JSON.stringify({ masked, history }).includes('VIS-SECRET-ID-42'), 'the supplier id never reaches a customer payload');

  // Reconciliation is audited with the admin identity.
  const audit = db.prepare("SELECT * FROM security_logs WHERE action='order_reconcile_accept'").all();
  assert.ok(audit.length >= 1, 'the reconcile action is in the audit log');
  assert.ok(audit.some((a) => a.user_id === admin.id), 'the audit row names the admin');

  // The admin list route is mounted behind requireAdmin, and the customer routes
  // never import the supplier identifiers.
  const adminRoute = readFileSync(path.join(ROOT, 'server', 'routes', 'admin.orders.js'), 'utf8');
  assert.ok(/r\.use\(requireAdmin\)/.test(adminRoute), 'every admin order route requires an admin');
  assert.ok(!/provider_order_id/.test(readFileSync(path.join(ROOT, 'server', 'routes', 'client.orders.js'), 'utf8')),
    'the customer order route never handles the supplier order id');
});

// 11 ─────────────────────────────────────────────────────────────────────────
await t('[11] provider errors and secrets: keys redacted, categories only, alerts deduplicated', async () => {
  const adapter = smmpostFactory({ api_url: 'https://supplier.invalid/api', api_key: SECRET, name: 'SMM', currency: 'USD' });
  try {
    // A supplier that echoes the key back in an explicit refusal.
    globalThis.fetch = async () => new Response(JSON.stringify({ error: `Invalid key ${SECRET}` }), { status: 200 });
    const e1 = await adapter.placeOrder({ service: '1', link: 'x', quantity: 10 }).catch((e) => e);
    assert.strictEqual(e1.kind, 'rejected');
    assert.ok(!e1.message.includes(SECRET), 'the API key is redacted from the error');
    assert.strictEqual(e1.category, 'provider_rejected');

    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Not enough balance' }), { status: 200 });
    const e2 = await adapter.placeOrder({ service: '1', link: 'x', quantity: 10 }).catch((e) => e);
    assert.strictEqual(e2.category, 'insufficient_supplier_funds');
  } finally {
    globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };
  }

  // A raw message that contains the key never reaches the stored provider error or the customer.
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  behaviour = () => { throw unknownOutcome('ambiguous', `leaked ${SECRET}`); };
  const res = await outcome(place(U(u.id), s, 'https://instagram.com/secret-1'));
  assert.ok(!JSON.stringify(res.error).includes(SECRET), 'the customer error carries no secret');
  const lastError = db.prepare('SELECT last_error FROM providers WHERE id=?').get(p.id).last_error;
  assert.ok(!String(lastError).includes(SECRET), 'the provider error record carries no secret');
  assert.ok(!alertsLogged().some((a) => a.detail.includes(SECRET)), 'no alert carries a secret');

  // Unknown categories collapse to a fixed label instead of passing through.
  assert.strictEqual(L.classifyProviderFailure(unknownOutcome('free text from supplier')).category, 'ambiguous');
  assert.strictEqual(L.classifyProviderFailure({ name: 'TimeoutError' }).category, 'timeout');
  assert.strictEqual(L.classifyProviderFailure(refused('provider_rejected')).kind, 'rejected');

  // Alerts are deduplicated: one private record per kind + provider + category per window.
  const first = L.alertAdmin('supplier_order_rejected', { providerId: 9001, providerName: 'Dedupe', orderRef: 'o1', category: 'provider_rejected' }, 1_000_000);
  const second = L.alertAdmin('supplier_order_rejected', { providerId: 9001, providerName: 'Dedupe', orderRef: 'o2', category: 'provider_rejected' }, 1_000_000 + 60_000);
  const later = L.alertAdmin('supplier_order_rejected', { providerId: 9001, providerName: 'Dedupe', orderRef: 'o3', category: 'provider_rejected' }, 1_000_000 + 11 * 60_000);
  assert.strictEqual(first, true);
  assert.strictEqual(second, false, 'a repeat within 10 minutes is not logged again');
  assert.strictEqual(later, true, 'a repeat after the window is logged again');
});

// 12 ─────────────────────────────────────────────────────────────────────────
await t('[12] existing order and pricing regressions', async () => {
  const p = makeProvider(); const s = makeService(p);
  const u = makeUser(500000);
  // Happy path: stored price equals the quoted price; link is trimmed; charge kept.
  behaviour = () => ({ id: 'REG-1', status: 'PENDING', charge: 7.5, currency: 'USD' });
  const final = finalFor(s);
  const order = await place(U(u.id), s, '   https://instagram.com/reg-trim   ');
  assert.strictEqual(order.price_inr - order.discount_inr, final, 'stored price matches the quote');
  const row = orderBy('user_id=?', u.id);
  assert.strictEqual(row.link, 'https://instagram.com/reg-trim', 'the link is stored trimmed');
  assert.strictEqual(Number(row.provider_charge), 7.5);

  // Mispriced services are refused before any reservation or supplier call.
  const free = makeService(p, { rate: 0, adminRate: 0 });
  const zero = await outcome(place(U(u.id), free, 'https://instagram.com/free'));
  assert.ok(!zero.ok && zero.error.code === 'BAD_PRICE');
  const neg = makeService(p, { rate: -5, adminRate: -5 });
  const negative = await outcome(place(U(u.id), neg, 'https://instagram.com/neg'));
  assert.ok(!negative.ok && negative.error.code === 'BAD_PRICE');

  // Quantity and link checks.
  const low = await outcome(orderRouter.placeOrder({ user: U(u.id), serviceId: s.id, link: 'https://instagram.com/q', quantity: 1 }));
  assert.ok(!low.ok && low.error.code === 'BAD_QTY');
  const noLink = await outcome(place(U(u.id), s, '   '));
  assert.ok(!noLink.ok && noLink.error.code === 'BAD_LINK');

  // An inactive supplier cannot receive orders.
  const dead = makeProvider({ active: 0 }); const deadSvc = makeService(dead);
  const inactive = await outcome(place(U(u.id), deadSvc, 'https://instagram.com/dead'));
  assert.ok(!inactive.ok && inactive.error.code === 'BAD_PROVIDER');

  assert.strictEqual(supplierCalls, 1, 'only the one valid order reached the supplier');
  // No-loss coupon clamp: a huge fixed coupon can never push the price below cost.
  const clamp = computePricing({ qty: 100, adminRate: 10, baseRate: 8, noProfit: false,
    coupon: { type: 'fixed_inr', value: 10 ** 9 } });
  assert.ok(clamp.final >= clamp.base, 'a coupon never prices an order below supplier cost');
});

// ---- summary ----------------------------------------------------------------
assert.strictEqual(unexpectedFetch, 0, `no real network call may be attempted (${unexpectedFetch})`);
globalThis.fetch = realFetch;
rmSync(TEST_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
