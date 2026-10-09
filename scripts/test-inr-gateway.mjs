// ---------------------------------------------------------------------------
// INR gateway (VCGetaway) — verification suite:
//   I1  the shared INR money math: ₹100 credit → ₹10 surcharge → ₹110 total
//   I2  fractional rupees round to whole paise; invalid amounts are rejected
//   I3  the wallet credit is never the total the customer pays
//   I4  the deposit page stays disconnected (GATEWAY_CONNECTED = false)
//   I5  no server route or webhook exists for the automated INR gateway
//   I6  the proposed VCGETAWAY_* variable names are read into configuration
//   I7  the deposit page uses the shared INR math (single source of truth)
//   I8  a client can request an INR deposit — a PENDING record with the
//       correct credit / 10% surcharge / total; nothing is credited
//   I9  invalid amounts are rejected (400) and create nothing
//   I10 a customer "I have paid" claim is RECORDED, never treated as
//       proof — the wallet stays untouched
//   I11 admin verification of the actual payment credits the wallet the
//       CREDIT amount (₹100, never ₹110), atomically with the ledger
//   I12 verification is idempotent — a second verify credits nothing
//   I13 a denied deposit credits nothing and can never be verified
//   I14 clients cannot verify (403) and cannot read or claim another
//       user's deposit (404)
//   I15 verify / deny require a stated reason (audit trail)
//   I16 concurrent verification credits the wallet exactly once;
//       the audit detail is recorded in the detail column (never
//       the ip column); unknown ids return a clean 404
//
// Usage: node scripts/test-inr-gateway.mjs
//
// I1–I7 are pure (no database). I8–I15 run the workflow routers against a
// THROWAWAY SQLite database (DB_FILE is honored at import time, so it is set
// before any server module loads). FAKE gateway credentials only — no network
// calls are made anywhere in this suite, and no sample data from VCGetaway's
// example pages is used anywhere.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// --- environment BEFORE any server module is imported (config.js reads it)
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-inrgw-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'inrgw.db');
process.env.SESSION_SECRET = 'inrgw-session-secret';
process.env.ADMIN_EMAIL_1 = 'inrgw-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'inrgw-admin-pass-123';
// FAKE credentials only — the gateway has no API contract yet, so these are
// never used for a request; they only prove the variables are read.
process.env.VCGETAWAY_API_KEY = 'fake-vc-key-0000';
process.env.VCGETAWAY_API_URL = 'https://api.fake-vcgetaway.test';
process.env.VCGETAWAY_WEBHOOK_SECRET = 'fake-vc-webhook-secret-0000';

// always clean up our own throwaway directory
process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// The shared money math is plain ESM (no JSX) — importable directly.
const { SURCHARGE_BPS, MAX_CREDIT_PAISE_EXACT, inrCreditPaise, inrSurchargePaise, inrTotalPaise } =
  await import('../client/src/lib/inrPayments.js');
// Largest whole-rupee amount the integer-precision guard accepts (not a business cap).
const MAX_WHOLE_RUPEES = Math.floor(MAX_CREDIT_PAISE_EXACT / 100);
const { config } = await import('../server/config.js');
const { getDb } = await import('../server/db.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const clientInrRoutes = (await import('../server/routes/client.inrDeposits.js')).default;
const adminInrRoutes = (await import('../server/routes/admin.inrDeposits.js')).default;
const rootDir = config.rootDir;

const db = getDb();

// ---------------------------------------------------------------------------
// Tiny harness (mirrors scripts/test-env-config.mjs)
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

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {}, headers = {} } = {}) {
  const req = { method, url, query, body, cookies, headers, ip: '127.0.0.1', user: null };
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
     VALUES (?,?, 'client', 'InrGateway', ?, 0, 'active', 0, ?)`
  ).run(email, hashPassword('inrgw-pass-1'), balancePaise, now);
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

function walletBalance(userId) {
  return db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(userId).wallet_balance;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get('inrgw-admin@test.dev');
assert.ok(adminUser && adminUser.role === 'admin', 'admin seed missing');
const clientUser = createUser('inrgw-client@test.dev', 0);
const otherUser = createUser('inrgw-other@test.dev', 0);
const adminCookies = makeSession(adminUser.id);
const clientCookies = makeSession(clientUser.id);
const otherCookies = makeSession(otherUser.id);

console.log('I1/I2/I3 — INR money math (integer paise only)');

await t('I1: ₹100 credit → ₹10 surcharge → ₹110 total', () => {
  const credit = inrCreditPaise(100);
  assert.strictEqual(credit, 10000, '₹100 is 10000 paise');
  assert.strictEqual(inrSurchargePaise(credit), 1000, 'the 10% surcharge on ₹100 is ₹10');
  assert.strictEqual(inrTotalPaise(credit), 11000, 'the customer pays ₹110 total');
  assert.strictEqual(SURCHARGE_BPS, 1000, 'the surcharge is 10% expressed in basis points');
});

await t('I2: fractional rupees round to whole paise; invalid and excessive amounts are rejected', () => {
  assert.strictEqual(inrCreditPaise(100.5), 10050, '₹100.50 is 10050 paise');
  assert.strictEqual(inrCreditPaise('75'), 7500, 'numeric strings are accepted');
  assert.strictEqual(inrCreditPaise(MAX_WHOLE_RUPEES), MAX_WHOLE_RUPEES * 100, 'the largest exact amount is accepted');
  assert.strictEqual(inrCreditPaise(1_000_000_000), 100_000_000_000, 'there is no ₹1e9 business cap');
  for (const bad of [0, -50, 'abc', '', undefined, null, Infinity, NaN, 1e16, '1e21', true, 100.555, '100.555', '0x10', MAX_WHOLE_RUPEES + 1]) {
    assert.strictEqual(inrCreditPaise(bad), null, `amount ${String(bad)} must be rejected`);
  }
});

await t('I3: the wallet credit is never the total the customer pays', () => {
  for (const rupees of [1, 50, 100, 999, 1234.56]) {
    const credit = inrCreditPaise(rupees);
    const total = inrTotalPaise(credit);
    assert.ok(Number.isInteger(credit) && Number.isInteger(total), 'all money is integer paise');
    assert.notStrictEqual(total, credit, 'the total must always exceed the credit');
    assert.strictEqual(total - credit, inrSurchargePaise(credit),
      'the difference between total and credit is exactly the surcharge');
    assert.ok(total > credit, 'the customer pays more than the wallet receives');
  }
});

console.log('I4/I5 — the gateway stays disabled');

await t('I4: the deposit page stays disconnected (GATEWAY_CONNECTED = false)', () => {
  const src = readFileSync(path.join(rootDir, 'client', 'src', 'pages', 'client', 'VcDeposit.jsx'), 'utf8');
  assert.ok(src.includes('const GATEWAY_CONNECTED = false;'),
    'GATEWAY_CONNECTED must remain false');
  assert.ok(src.includes('if (!GATEWAY_CONNECTED || !valid) return;'),
    'the pay action must stay guarded by GATEWAY_CONNECTED');
});

await t('I5: no automated VCGetaway checkout/webhook integration is mounted (manual routes allowed)', () => {
  const indexSource = readFileSync(path.join(rootDir, 'server', 'index.js'), 'utf8');
  const webhookSource = readFileSync(path.join(rootDir, 'server', 'routes', 'webhooks.js'), 'utf8');

  // The intended MANUAL workflow routes ARE mounted — allowed, expected.
  assert.ok(indexSource.includes("app.use('/api/deposits/inr'"),
    'the manual client INR deposit router must be mounted');
  assert.ok(indexSource.includes("app.use('/api/admin/deposits/inr'"),
    'the manual admin INR verification router must be mounted');

  // No AUTOMATED gateway route or webhook is mounted anywhere, and the
  // sample site's /api/notify-payment endpoint is not mounted on our side.
  for (const [name, src] of [['server/index.js', indexSource], ['server/routes/webhooks.js', webhookSource]]) {
    assert.ok(!/app\.use\(\s*['"][^'"]*(vcgetaway|inr[-_.]?gateway)/i.test(src),
      `${name} must not mount an automated VCGetaway/INR-gateway route`);
    assert.ok(!/webhooks?\/(vcgetaway|inr[-_.]?gateway)/i.test(src),
      `${name} must not mount a VCGetaway/INR-gateway webhook`);
    assert.ok(!/notify-payment/.test(src),
      `${name} must not mount the sample site's /api/notify-payment endpoint`);
  }
  // webhooks.js contains no gateway integration at all.
  assert.ok(!/vcgetaway|vc_getaway|inr.?gateway/i.test(webhookSource),
    'server/routes/webhooks.js must contain no VCGetaway/INR-gateway integration');
});

console.log('I6/I7 — configuration and shared math');

await t('I6: the proposed VCGETAWAY_* variables are read into configuration', () => {
  assert.strictEqual(config.vcGetaway.apiKey, 'fake-vc-key-0000', 'VCGETAWAY_API_KEY must be read');
  assert.strictEqual(config.vcGetaway.apiUrl, 'https://api.fake-vcgetaway.test', 'VCGETAWAY_API_URL must be read');
  assert.strictEqual(config.vcGetaway.webhookSecret, 'fake-vc-webhook-secret-0000', 'VCGETAWAY_WEBHOOK_SECRET must be read');
});

await t('I7: the deposit page uses the shared INR math (single source of truth)', () => {
  const src = readFileSync(path.join(rootDir, 'client', 'src', 'pages', 'client', 'VcDeposit.jsx'), 'utf8');
  assert.ok(src.includes("from '../../lib/inrPayments.js'"),
    'the page must import the shared helpers');
  assert.ok(!src.includes('Math.round((creditPaise * SURCHARGE_BPS)'),
    'the surcharge math must not be duplicated inline');
});

console.log('I8/I9 — requesting an INR deposit (pending record only)');

await t('I8: a client can request an INR deposit — pending record, correct math, nothing credited', async () => {
  const before = walletBalance(clientUser.id);
  const r = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 100 }, cookies: clientCookies });
  assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  const d = r.body.deposit;
  assert.strictEqual(d.status, 'pending');
  assert.strictEqual(d.credit_paise, 10000);
  assert.strictEqual(d.surcharge_paise, 1000);
  assert.strictEqual(d.total_paise, 11000, 'the customer pays ₹110 for a ₹100 credit');
  assert.ok(d.created_at > 0);
  assert.strictEqual(walletBalance(clientUser.id), before, 'creating a deposit request must never credit the wallet');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(clientUser.id).c, 0);
});

await t('I9: invalid amounts are rejected and create nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM inr_deposits').get().c;
  for (const rupees of [0, -50, 'abc', '', null, 1e16, '1e21', String(MAX_WHOLE_RUPEES + 1)]) {
    const r = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees }, cookies: clientCookies });
    assert.strictEqual(r.statusCode, 400, `amount ${String(rupees)} must be rejected`);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM inr_deposits').get().c, before, 'no record may be created');
});

console.log('I10 — customer claims are recorded, never treated as proof');

await t('I10: a customer "I have paid" claim is recorded, never treated as proof of payment', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 50 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  const r = await call(clientInrRoutes, { method: 'POST', url: `/${id}/claim`, cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.deposit.status, 'awaiting_verification');
  assert.strictEqual(walletBalance(clientUser.id), before, 'a claim must NEVER credit the wallet');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(clientUser.id).c, 0);
  // A claim on an already-claimed deposit is refused.
  const again = await call(clientInrRoutes, { method: 'POST', url: `/${id}/claim`, cookies: clientCookies });
  assert.strictEqual(again.statusCode, 400);
});

console.log('I11/I12 — admin verification credits the CREDIT amount, once');

await t('I11: admin verification credits the wallet the CREDIT amount (₹100, never ₹110), atomically', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 100 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  const r = await call(adminInrRoutes, {
    method: 'POST', url: `/${id}/verify`,
    body: {
      reason: 'UPI payment received and matched against the issued invoice',
      payment_ref: 'upi-ref-test-0001', invoice_ref: 'INV-TEST-0001',
    },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.inr, 10000, 'the wallet must receive the CREDIT (₹100), never the total (₹110)');
  assert.strictEqual(walletBalance(clientUser.id), before + 10000);
  const row = db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(id);
  assert.strictEqual(row.status, 'verified');
  assert.strictEqual(Number(row.verified_by), adminUser.id);
  assert.ok(row.verified_at > 0);
  assert.strictEqual(row.payment_ref, 'upi-ref-test-0001');
  assert.strictEqual(row.invoice_ref, 'INV-TEST-0001');
  assert.ok(String(row.verify_note).includes('UPI payment received'));
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id=? AND ref_id=? AND type=?').get(clientUser.id, id, 'deposit');
  assert.ok(tx, 'a ledger entry must exist');
  assert.strictEqual(tx.amount_inr, 10000);
  assert.strictEqual(tx.balance_after, before + 10000);
  const meta = JSON.parse(tx.meta_json);
  assert.strictEqual(meta.method, 'inr_manual');
  assert.strictEqual(meta.total_paise, 11000, 'the ledger records what the customer paid');
  assert.strictEqual(meta.surcharge_paise, 1000);
});

await t('I12: verification is idempotent — a second verify credits nothing', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 25 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  const first = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'verified once' }, cookies: adminCookies });
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(walletBalance(clientUser.id), before + 2500);
  const second = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'verified twice' }, cookies: adminCookies });
  assert.strictEqual(second.statusCode, 400);
  assert.strictEqual(walletBalance(clientUser.id), before + 2500, 'the wallet may be credited exactly once');
  const txs = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND ref_id=?').get(clientUser.id, id).c;
  assert.strictEqual(txs, 1, 'exactly one ledger entry may exist');
});

console.log('I13 — denial is terminal and credits nothing');

await t('I13: a denied deposit credits nothing and can never be verified afterwards', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 75 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  const deny = await call(adminInrRoutes, { method: 'POST', url: `/${id}/deny`, body: { reason: 'No matching UPI payment found' }, cookies: adminCookies });
  assert.strictEqual(deny.statusCode, 200, JSON.stringify(deny.body));
  assert.strictEqual(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(id).status, 'denied');
  assert.strictEqual(walletBalance(clientUser.id), before, 'a denied deposit must never credit the wallet');
  const lateVerify = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'late attempt' }, cookies: adminCookies });
  assert.strictEqual(lateVerify.statusCode, 400);
  assert.strictEqual(walletBalance(clientUser.id), before);
});

console.log('I14/I15 — authorization boundaries and audit trail');

await t('I14: clients cannot verify; other users\' deposits are invisible', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 10 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  // A client session cannot reach the admin verification endpoints.
  const clientVerify = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'attempt' }, cookies: clientCookies });
  assert.strictEqual(clientVerify.statusCode, 403);
  const anonVerify = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'attempt' } });
  assert.strictEqual(anonVerify.statusCode, 401);
  // Another client cannot read or claim this deposit.
  const peek = await call(clientInrRoutes, { method: 'GET', url: `/${id}`, cookies: otherCookies });
  assert.strictEqual(peek.statusCode, 404);
  const steal = await call(clientInrRoutes, { method: 'POST', url: `/${id}/claim`, cookies: otherCookies });
  assert.strictEqual(steal.statusCode, 404);
  // The owner sees it; the admin listing includes the account email.
  const own = await call(clientInrRoutes, { method: 'GET', url: `/${id}`, cookies: clientCookies });
  assert.strictEqual(own.statusCode, 200);
  const list = await call(adminInrRoutes, { method: 'GET', url: '/', cookies: adminCookies });
  assert.strictEqual(list.statusCode, 200);
  const found = list.body.deposits.find((d) => d.id === id);
  assert.ok(found && found.email === 'inrgw-client@test.dev', 'the admin listing must show the account email');
  assert.strictEqual(walletBalance(clientUser.id), before);
});

await t('I15: verify and deny require a stated reason (audit trail)', async () => {
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 20 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  const noReason = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: {}, cookies: adminCookies });
  assert.strictEqual(noReason.statusCode, 400);
  const shortReason = await call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'x' }, cookies: adminCookies });
  assert.strictEqual(shortReason.statusCode, 400);
  const denyNoReason = await call(adminInrRoutes, { method: 'POST', url: `/${id}/deny`, body: { reason: '' }, cookies: adminCookies });
  assert.strictEqual(denyNoReason.statusCode, 400);
  // Still pending — none of the rejected attempts changed anything.
  assert.strictEqual(db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(id).status, 'pending');
});

console.log('I16 — concurrency, audit trail and unknown ids');

await t('I16: concurrent verification credits the wallet exactly once; audit detail never lands in the ip column', async () => {
  const before = walletBalance(clientUser.id);
  const created = await call(clientInrRoutes, { method: 'POST', url: '/', body: { rupees: 100 }, cookies: clientCookies });
  const id = created.body.deposit.id;
  // Two verification requests for the same deposit racing each other
  // (two admin tabs). The conditional status transition inside the
  // transaction lets exactly one of them win — the other is refused
  // and the wallet is credited exactly once.
  const [a, b] = await Promise.all([
    call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'first verifier' }, cookies: adminCookies }),
    call(adminInrRoutes, { method: 'POST', url: `/${id}/verify`, body: { reason: 'second verifier' }, cookies: adminCookies }),
  ]);
  assert.strictEqual([a, b].filter((r) => r.statusCode === 200).length, 1, 'exactly one concurrent verify may succeed');
  assert.strictEqual([a, b].filter((r) => r.statusCode === 400).length, 1, 'the racing verify must be refused');
  assert.strictEqual(walletBalance(clientUser.id), before + 10000, 'the wallet may be credited exactly once');
  const txs = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND ref_id=?').get(clientUser.id, id).c;
  assert.strictEqual(txs, 1, 'exactly one ledger entry may exist');
  // The audit row: the actor and the reason/deposit reference are
  // recorded in their own columns — the detail must never be
  // stuffed into the ip column.
  const logRow = db.prepare(
    "SELECT * FROM security_logs WHERE action='verify_inr_deposit' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(logRow, 'the verification must be audit-logged');
  assert.strictEqual(logRow.email, 'inrgw-admin@test.dev', 'the audit log records the verifying admin');
  assert.ok(logRow.detail && logRow.detail.includes(`inr deposit #${id}`) && logRow.detail.includes('verifier'),
    'the reason and deposit reference are recorded in the detail column');
  assert.ok(!String(logRow.ip || '').includes('inr deposit'), 'the audit detail must never leak into the ip column');
  // Unknown ids are a clean 404, not a 500.
  const missing = await call(adminInrRoutes, { method: 'POST', url: '/999999999/verify', body: { reason: 'valid reason' }, cookies: adminCookies });
  assert.strictEqual(missing.statusCode, 404, 'an unknown deposit id must 404');
});

// ---------------------------------------------------------------------------
console.log(`\ninr-gateway: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
