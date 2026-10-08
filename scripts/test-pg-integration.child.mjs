// ---------------------------------------------------------------------------
// PostgreSQL integration invariants — CHILD process.
//
// scripts/test-pg-integration.mjs creates the scratch database,
// spawns THIS file with DATABASE_URL pointing at it, relays the
// output, then drops the database. Never run this file directly
// except against a throwaway database.
//
// It boots the REAL application stack (server/db.js getDb, the
// actual routers and the money libs) against PostgreSQL and asserts
// the invariants the SQLite suite covers: first-boot seeding, admin
// authentication, provider masking, order placement with the
// atomic conditional wallet debit + ledger, provider-failure
// no-loss behavior, concurrent double-spend protection, coupon
// atomicity, verified-deposit crediting, the INR manual-
// verification workflow, admin wallet adjustments, ILIKE search,
// numeric aggregate types, ON CONFLICT upserts, unique-violation
// detection, multi-statement exec and explicit transaction
// rollback.
//
// No network calls are made: SMM_TEST=1 seeds the local demo
// provider/adapter.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createHash } from 'node:crypto';

// The parent sets DATABASE_URL (scratch database) before this file
// is loaded; SMM_TEST=1 seeds the demo provider + catalog so the
// ordering flows run entirely locally.
process.env.SMM_TEST = '1';
process.env.DEMO_SPEED = '1000';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'pg-integration-secret';
process.env.ADMIN_EMAIL_1 = process.env.ADMIN_EMAIL_1 || 'pg-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = process.env.ADMIN_PASSWORD_1 || 'pg-admin-pass-123';

const { getDb, getExchangeRate, isUniqueViolation } = await import('../server/db.js');
const { placeOrder, quoteOrder, orderWithService, InsufficientBalanceError } = await import('../server/lib/orderRouter.js');
const { creditDeposit } = await import('../server/lib/apirone.js');
const { usdToInr } = await import('../server/lib/money.js');
const { createInrDeposit, claimInrDeposit, verifyInrDeposit } = await import('../server/lib/inrDeposits.js');
const { adminAdjustBalance } = await import('../server/lib/wallet.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const adminAuthRouter = (await import('../server/routes/admin.auth.js')).default;
const providersRouter = (await import('../server/routes/admin.providers.js')).default;
const clientServicesRouter = (await import('../server/routes/client.services.js')).default;

const db = getDb();
assert.strictEqual(db.isPg, true, 'getDb() must return the PostgreSQL bridge when DATABASE_URL is set');

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-regressions.mjs)
// ---------------------------------------------------------------------------
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

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type() { return this; },
    cookie() { return this; },
    clearCookie() { return this; },
  };
  return res;
}

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {}, headers = {}, remoteAddress = undefined } = {}) {
  const req = { method, url, query, body, cookies, headers, ip: '127.0.0.1', user: null };
  if (remoteAddress) req.socket = { remoteAddress };
  const res = makeRes();
  let nextErr = null;
  await router(req, res, (e) => { nextErr = e || null; });
  if (nextErr) throw nextErr;
  return res;
}

function makeSession(userId) {
  const token = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, ip, expires_at, created_at) VALUES (?,?,?,?,?)'
  ).run(createHash('sha256').update(token).digest('hex'), userId, '127.0.0.1',
    Date.now() + 86_400_000, Date.now());
  return { instasmm_session: token };
}

function createUser(email, balancePaise) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?, 'client', 'PG Test', ?, 0, 'active', 0, ?)`
  ).run(email, hashPassword('pg-test-pass-1'), balancePaise, now);
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

function firstDemoService() {
  const svc = db.prepare(
    `SELECT * FROM services
     WHERE provider_id = (SELECT id FROM providers WHERE adapter='demo') AND status=1
     ORDER BY id LIMIT 1`
  ).get();
  assert.ok(svc, 'seeded demo service missing — SMM_TEST=1 seeding must be active');
  return svc;
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL_1;
const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get(ADMIN_EMAIL);
assert.ok(adminUser && adminUser.role === 'admin', 'admin seed missing');
const adminCookies = makeSession(adminUser.id);

console.log('PG — application invariants against PostgreSQL');

// ---------------------------------------------------------------------------
// Boot & seeding
// ---------------------------------------------------------------------------

await t('first boot seeds admins, the demo client, settings and the test catalog', async () => {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get();
  assert.ok(users.c >= 2, `expected admin + demo client, got ${users.c}`);
  const settings = db.prepare('SELECT COUNT(*) c FROM settings').get();
  assert.ok(settings.c > 0, 'default settings seeded');
  const cats = db.prepare('SELECT COUNT(*) c FROM categories').get();
  assert.strictEqual(cats.c, 6, 'six demo categories');
  const svcs = db.prepare('SELECT COUNT(*) c FROM services').get();
  assert.strictEqual(svcs.c, 14, 'fourteen demo services');
  const demo = db.prepare("SELECT id FROM providers WHERE adapter='demo'").get();
  assert.ok(demo, 'demo provider seeded under SMM_TEST=1');
});

await t('lastInsertRowid is a number (RETURNING id round-trip)', async () => {
  const res = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (?,?,?,?,?)'
  ).run(adminUser.id, 'general', 'pg test', 'body', Date.now());
  assert.strictEqual(typeof res.lastInsertRowid, 'number');
  assert.ok(res.lastInsertRowid > 0);
  assert.strictEqual(res.changes, 1);
});

// ---------------------------------------------------------------------------
// Auth & catalog surface
// ---------------------------------------------------------------------------

await t('admin login via the real router starts a session', async () => {
  const r = await call(adminAuthRouter, {
    method: 'POST', url: '/login',
    body: { email: ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD_1 },
    remoteAddress: '203.0.113.10',
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.user.role, 'admin');
  assert.ok(!('password_hash' in r.body.user), 'the password hash is never serialized');
});

await t('provider create + list: credentials stored server-side, response masked', async () => {
  const r = await call(providersRouter, {
    method: 'POST', url: '/',
    body: {
      name: 'PG Provider', adapter: 'smmpost',
      api_url: 'https://api.example.com/smm', api_key: 'sk-pg-integration',
      active: 1, currency: 'USD', markup_type: 'percent', markup_value: 20,
    },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(!('api_key' in r.body) && !('api_url' in r.body), 'secrets must never be serialized');
  assert.strictEqual(r.body.has_api_key, true);
  const row = db.prepare('SELECT * FROM providers WHERE name=?').get('PG Provider');
  assert.ok(row, 'provider row missing');
  assert.strictEqual(row.api_key, 'sk-pg-integration', 'the API key must persist in the database');
  const list = await call(providersRouter, { method: 'GET', url: '/', cookies: adminCookies });
  assert.strictEqual(list.statusCode, 200);
  const leak = (list.body.providers || []).filter((p) => p.api_key || p.api_url);
  assert.strictEqual(leak.length, 0, 'secret fields leaked into the admin payload');
  const mine = (list.body.providers || []).find((p) => p.name === 'PG Provider');
  assert.ok(mine && mine.has_api_key === true && mine.api_url_masked, 'masked facts must be present');
  assert.strictEqual(typeof mine.service_count, 'number', 'COUNT(*) must arrive as a number, not an int8 string');
});

await t('client catalog: categories and services served with client-safe pricing', async () => {
  const demo = db.prepare('SELECT * FROM users WHERE email=?').get('demo@instasmm.store');
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: makeSession(demo.id) });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.body.categories.length >= 6, 'all six categories listed');
  assert.strictEqual(r.body.provider_configured, true);
  const all = r.body.categories.flatMap((c) => c.services);
  assert.ok(all.length >= 14, 'all demo services listed');
  for (const s of all) {
    assert.ok(!('provider_rate' in s) && !('admin_rate' in s), 'cost rates must never leak to clients');
  }
});

// ---------------------------------------------------------------------------
// Dialect behavior against a real PostgreSQL
// ---------------------------------------------------------------------------

await t('ILIKE: case-insensitive LIKE matching (SQLite semantics preserved)', async () => {
  const upper = db.prepare('SELECT COUNT(*) c FROM services WHERE name LIKE ?').get('%INSTAGRAM%');
  assert.ok(upper.c >= 1, 'an UPPERCASE pattern must match mixed-case rows via ILIKE');
  const lower = db.prepare('SELECT COUNT(*) c FROM services WHERE name LIKE ?').get('%youtube%');
  assert.ok(lower.c >= 1, 'a lowercase pattern must match mixed-case rows via ILIKE');
});

await t('numeric aggregates return JS numbers (int8 type parser active)', async () => {
  const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(wallet_balance), 0) AS total FROM users').get();
  assert.strictEqual(typeof row.n, 'number', 'COUNT(*) must be a number');
  assert.strictEqual(typeof row.total, 'number', 'SUM() must be a number');
});

await t('ON CONFLICT DO NOTHING: INSERT OR IGNORE never duplicates a settings key', async () => {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('pg_test_key', 'first');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('pg_test_key', 'second');
  const rows = db.prepare('SELECT * FROM settings WHERE key=?').all('pg_test_key');
  assert.strictEqual(rows.length, 1, 'the duplicate insert must be skipped, not applied');
  assert.strictEqual(rows[0].value, 'first');
});

await t('a real unique violation is detected (isUniqueViolation, SQLSTATE 23505)', async () => {
  const ins = db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const now = Date.now();
  ins.run('pg-dup@test.dev', hashPassword('x'), 'client', 'D', 0, 0, 'active', 0, now);
  let err = null;
  try {
    ins.run('pg-dup@test.dev', hashPassword('x'), 'client', 'D', 0, 0, 'active', 0, now);
  } catch (e) { err = e; }
  assert.ok(err, 'the second insert must fail on the unique email constraint');
  assert.ok(isUniqueViolation(err), `expected a unique violation, got: ${err.message}`);
});

await t('multi-statement exec runs DDL and DML batches (simple protocol)', async () => {
  db.exec('CREATE TABLE pg_bridge_scratch (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT NOT NULL)');
  db.exec("INSERT INTO pg_bridge_scratch (v) VALUES ('a'); INSERT INTO pg_bridge_scratch (v) VALUES ('b')");
  const n = db.prepare('SELECT COUNT(*) c FROM pg_bridge_scratch').get();
  assert.strictEqual(n.c, 2, 'both statements in the batch must execute');
  db.exec('DROP TABLE pg_bridge_scratch');
});

await t('explicit transaction: ROLLBACK discards the change', async () => {
  const u = createUser('pg-tx@test.dev', 1000);
  db.exec('BEGIN');
  db.prepare('UPDATE users SET wallet_balance=? WHERE id=?').run(99999, u.id);
  db.exec('ROLLBACK');
  const after = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(u.id);
  assert.strictEqual(after.wallet_balance, 1000, 'the rolled-back update must not persist');
});

// ---------------------------------------------------------------------------
// Money & ordering invariants
// ---------------------------------------------------------------------------

await t('order placement: provider-first routing, atomic debit, ledger and order row', async () => {
  const svc = firstDemoService();
  const quote = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: null, noProfit: false });
  const buyer = createUser('pg-order@test.dev', quote.final);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(buyer.id);
  const order = await placeOrder({ user, serviceId: svc.id, link: 'https://example.com/pg', quantity: svc.min });
  assert.ok(order && order.id > 0, 'an order row must be returned');
  assert.strictEqual(order.price_inr, quote.final, 'the charged price is the quoted price');
  assert.ok(order.provider_order_id, 'the provider order id is stored');
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(wallet.wallet_balance, 0, 'the wallet is debited exactly the order price');
  const ledger = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='order'").all(user.id);
  assert.strictEqual(ledger.length, 1, 'exactly one ledger entry');
  assert.strictEqual(ledger[0].amount_inr, -quote.final);
  assert.strictEqual(ledger[0].balance_after, 0);
  const stored = orderWithService(db, order.id);
  assert.ok(!('base_cost_inr' in stored), 'the provider cost never leaks');
});

await t('provider failure debits nothing (no-loss guarantee)', async () => {
  const svc = firstDemoService();
  const quote = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: null, noProfit: false });
  const buyer = createUser('pg-fail@test.dev', quote.final);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(buyer.id);
  await assert.rejects(
    () => placeOrder({ user, serviceId: svc.id, link: 'https://example.com/fail', quantity: svc.min }),
    (e) => e.code === 'PROVIDER_ERROR'
  );
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(wallet.wallet_balance, quote.final, 'nothing was debited');
  const orders = db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id);
  assert.strictEqual(orders.c, 0, 'no order row was written');
});

await t('concurrent orders: a wallet funding exactly one order is spent exactly once', async () => {
  const svc = firstDemoService();
  const quote = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: null, noProfit: false });
  const buyer = createUser('pg-race@test.dev', quote.final);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(buyer.id);
  const results = await Promise.allSettled([
    placeOrder({ user, serviceId: svc.id, link: 'https://example.com/race-a', quantity: svc.min }),
    placeOrder({ user, serviceId: svc.id, link: 'https://example.com/race-b', quantity: svc.min }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactly one order succeeds');
  assert.strictEqual(bad.length, 1, 'the concurrent order must be rejected');
  assert.ok(bad[0].reason instanceof InsufficientBalanceError, 'the loser gets INSUFFICIENT_BALANCE');
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(wallet.wallet_balance, 0, 'the wallet is debited exactly once');
  const ledger = db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='order'").get(user.id);
  assert.strictEqual(ledger.c, 1, 'exactly one ledger entry');
  const orders = db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id);
  assert.strictEqual(orders.c, 1, 'exactly one order row');
});

await t('coupon atomicity: a usage-limited coupon is consumed exactly once', async () => {
  const svc = firstDemoService();
  const now = Date.now();
  db.prepare(
    `INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
     VALUES (?,?,?,?,?,?,1,?,0,?)`
  ).run('PGONCE', 'percent', 10, 0, now, now + 3_600_000, 1, now);
  const quote = quoteOrder({ serviceId: svc.id, quantity: svc.min, couponCode: 'PGONCE', noProfit: false });
  const budget = quote.final * 2; // funds BOTH orders — only the coupon limit stops the second
  const buyer = createUser('pg-coupon@test.dev', budget);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(buyer.id);
  const results = await Promise.allSettled([
    placeOrder({ user, serviceId: svc.id, link: 'https://example.com/c1', quantity: svc.min, couponCode: 'PGONCE' }),
    placeOrder({ user, serviceId: svc.id, link: 'https://example.com/c2', quantity: svc.min, couponCode: 'PGONCE' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'exactly one order applies the coupon');
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].reason.code, 'BAD_COUPON', 'the loser fails on coupon consumption and rolls back');
  const coupon = db.prepare('SELECT * FROM coupons WHERE code=?').get('PGONCE');
  assert.strictEqual(coupon.used_count, 1, 'the coupon is consumed exactly once');
  const uses = db.prepare('SELECT COUNT(*) c FROM coupon_uses WHERE coupon_id=?').get(coupon.id);
  assert.strictEqual(uses.c, 1);
  const orders = db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id=?').get(user.id);
  assert.strictEqual(orders.c, 1, 'the rolled-back order leaves no row');
  const spent = db.prepare("SELECT COALESCE(SUM(amount_inr),0) s FROM transactions WHERE user_id=? AND type='order'").get(user.id);
  assert.strictEqual(spent.s, -quote.final, 'the wallet is debited exactly once');
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id);
  assert.strictEqual(wallet.wallet_balance, budget - quote.final);
});

await t('creditDeposit: a verified payment credits the wallet once, with a ledger entry', async () => {
  const buyer = createUser('pg-deposit@test.dev', 0);
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO deposits (user_id, invoice_id, currency, amount_usd, amount_inr, address, status, is_simulated, paid_usd, expires_at, created_at)
     VALUES (?,?,?,?,?,NULL,'pending',1,0,?,?)`
  ).run(buyer.id, 'SIM-PG-1', 'LTC', 100, 10000, now + 3_600_000, now);
  const depositId = Number(ins.lastInsertRowid);
  const expected = usdToInr(100, getExchangeRate());
  const first = creditDeposit(depositId);
  assert.strictEqual(first.ok, true, 'the first credit succeeds');
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(buyer.id);
  assert.strictEqual(wallet.wallet_balance, expected, `the wallet is credited the verified INR amount (${expected})`);
  const ledger = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='deposit'").all(buyer.id);
  assert.strictEqual(ledger.length, 1, 'exactly one ledger entry');
  const again = creditDeposit(depositId);
  assert.strictEqual(again.ok, false, 'a confirmed deposit can never be credited twice');
  const wallet2 = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(buyer.id);
  assert.strictEqual(wallet2.wallet_balance, expected, 'the balance is unchanged by the second attempt');
});

await t('INR manual-verification flow: claim records, verify credits the CREDIT amount exactly once', async () => {
  const buyer = createUser('pg-inr@test.dev', 0);
  const created = createInrDeposit({ userId: buyer.id, rupees: 100 });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.deposit.credit_paise, 10000, '₹100 credit');
  assert.strictEqual(created.deposit.surcharge_paise, 1000, '10% customer surcharge');
  assert.strictEqual(created.deposit.total_paise, 11000, 'the customer pays the total');
  const claimed = claimInrDeposit({ userId: buyer.id, depositId: created.deposit.id });
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.deposit.status, 'awaiting_verification');
  const verified = verifyInrDeposit({
    adminId: adminUser.id, depositId: created.deposit.id,
    paymentRef: 'UPI-PG-1', invoiceRef: 'INV-PG-1',
    note: 'verified against the operator dashboard',
  });
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.inr, 10000, 'the CREDIT amount is credited — never the surcharge-inclusive total');
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(buyer.id);
  assert.strictEqual(wallet.wallet_balance, 10000);
  const ledger = db.prepare("SELECT * FROM transactions WHERE user_id=? AND type='deposit'").all(buyer.id);
  assert.strictEqual(ledger.length, 1, 'exactly one ledger entry');
  assert.strictEqual(ledger[0].amount_inr, 10000);
  const meta = JSON.parse(ledger[0].meta_json);
  assert.strictEqual(meta.method, 'inr_manual');
  // Idempotent: a second verification changes nothing.
  const again = verifyInrDeposit({ adminId: adminUser.id, depositId: created.deposit.id, paymentRef: 'UPI-PG-2', note: 'x' });
  assert.strictEqual(again.ok, false, 're-verification is refused');
  const wallet2 = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(buyer.id);
  assert.strictEqual(wallet2.wallet_balance, 10000, 'the balance is unchanged');
});

await t('admin wallet adjustment: credit, debit, and negative-balance refusal', async () => {
  const target = createUser('pg-adjust@test.dev', 1000);
  const credit = adminAdjustBalance(adminUser, target.id, 500, 'test credit');
  assert.strictEqual(credit.newBalance, 1500);
  const debit = adminAdjustBalance(adminUser, target.id, -200, 'test debit');
  assert.strictEqual(debit.newBalance, 1300);
  assert.throws(
    () => adminAdjustBalance(adminUser, target.id, -2000, 'overdraft'),
    (e) => e.code === 'BAD_AMOUNT'
  );
  const wallet = db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(target.id);
  assert.strictEqual(wallet.wallet_balance, 1300, 'the refused debit changes nothing');
  const ledger = db.prepare("SELECT type FROM transactions WHERE user_id=? ORDER BY id").all(target.id);
  assert.deepStrictEqual(
    ledger.map((l) => l.type),
    ['admin_credit', 'admin_debit']
  );
});

console.log(`\npg-integration: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
