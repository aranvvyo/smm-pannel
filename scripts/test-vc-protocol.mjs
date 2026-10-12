// ---------------------------------------------------------------------------
// VC Gateway protocol tests. MOCKED transport only: no network, no real
// payments, no production data. The fetch global is replaced so any real
// request fails the suite.
//   run: node scripts/test-vc-protocol.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `vc-protocol-test-${process.pid}.db`);
const SECRET_KEY = 'TEST-ONLY-KEY-vc-protocol-4a1b';
process.env.DB_FILE = DB_FILE;
process.env.VCGETAWAY_API_KEY = SECRET_KEY;
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';

// No real network from this suite. Any fetch is a test failure.
let unexpectedFetch = 0;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const { config } = await import(path.join(ROOT, 'server', 'config.js'));
const proto = await import(path.join(ROOT, 'server', 'lib', 'vcGatewayProtocol.js'));
const ad = await import(path.join(ROOT, 'server', 'lib', 'vcGatewayAdapter.js'));
const ver = await import(path.join(ROOT, 'server', 'lib', 'inrVerification.js'));
const inr = await import(path.join(ROOT, 'server', 'lib', 'inrDeposits.js'));
const order = await import(path.join(ROOT, 'server', 'lib', 'inrOrder.js'));
const db = dbm.getDb();
if (db.isPg) throw new Error('test-vc-protocol must run on the temporary SQLite file, not PostgreSQL');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}

const ORDER = 'ORD261012ABCDEF';
const API = 'https://vcgatewaypro.com/payment_api.php';

console.log('VC Gateway protocol tests (mocked transport)');

// ---- 1. Documented request ------------------------------------------------
await t('request uses the documented host, path, and the three documented parameters', () => {
  const req = proto.buildVerificationRequest({ apiUrl: API, apiKey: SECRET_KEY, orderId: ORDER, totalPaise: 11000 });
  const u = new URL(req.url);
  assert.strictEqual(req.method, 'GET');
  assert.strictEqual(u.protocol, 'https:');
  assert.strictEqual(u.hostname, 'vcgatewaypro.com');
  assert.strictEqual(u.pathname, '/payment_api.php');
  assert.deepStrictEqual([...u.searchParams.keys()].sort(), ['amount', 'api_key', 'order_id']);
  assert.strictEqual(u.searchParams.get('order_id'), ORDER);
  assert.strictEqual(u.searchParams.get('api_key'), SECRET_KEY);
});

await t('amount is the TOTAL payable in rupees (₹110 total → 110.00; ₹1 minimum → 1.00)', () => {
  const big = new URL(proto.buildVerificationRequest({ apiUrl: API, apiKey: SECRET_KEY, orderId: ORDER, totalPaise: 11000 }).url);
  const min = new URL(proto.buildVerificationRequest({ apiUrl: API, apiKey: SECRET_KEY, orderId: ORDER, totalPaise: 100 }).url);
  assert.strictEqual(big.searchParams.get('amount'), '110.00');
  assert.strictEqual(min.searchParams.get('amount'), '1.00');
});

await t('refuses any URL that is not the documented HTTPS endpoint (no key sent elsewhere)', () => {
  const bad = [
    'http://vcgatewaypro.com/payment_api.php',
    'https://vcapi.vcstore.site/payment_api.php',
    'https://vcgatewaypro.com.evil.example/payment_api.php',
    'https://vcgatewaypro.com/other.php',
    'https://user:pass@vcgatewaypro.com/payment_api.php',
    'https://vcgatewaypro.com:8443/payment_api.php',
    'https://vcgatewaypro.com/payment_api.php?x=1',
    'https://vcgatewaypro.com/payment_api.php#frag',
    'not a url',
    '',
  ];
  for (const apiUrl of bad) {
    assert.throws(() => proto.buildVerificationRequest({ apiUrl, apiKey: SECRET_KEY, orderId: ORDER, totalPaise: 100 }),
      (e) => e.code === 'bad-api-url', `accepted ${apiUrl}`);
  }
});

await t('refuses an empty or whitespace key, and the error never contains the key', () => {
  for (const apiKey of ['', '   ', 'has space']) {
    assert.throws(() => proto.buildVerificationRequest({ apiUrl: API, apiKey, orderId: ORDER, totalPaise: 100 }),
      (e) => e.code === 'bad-api-key');
  }
  try {
    proto.buildVerificationRequest({ apiUrl: 'https://evil.example/x', apiKey: SECRET_KEY, orderId: ORDER, totalPaise: 100 });
  } catch (e) {
    assert.ok(!String(e.message).includes(SECRET_KEY) && !String(e.code).includes(SECRET_KEY), 'key leaked into an error');
  }
});

await t('refuses a malformed order id and any amount below ₹1 or not a safe integer', () => {
  for (const orderId of ['ORD1&am=0', 'ord261012abcdef', 'ORD261012ABCDE', '', null]) {
    assert.throws(() => proto.buildVerificationRequest({ apiUrl: API, apiKey: SECRET_KEY, orderId, totalPaise: 100 }),
      (e) => e.code === 'bad-order-id', `accepted ${orderId}`);
  }
  for (const totalPaise of [0, 99, -100, 1.5, NaN, Infinity, '100', null]) {
    assert.throws(() => proto.buildVerificationRequest({ apiUrl: API, apiKey: SECRET_KEY, orderId: ORDER, totalPaise }),
      (e) => e.code === 'below-provider-minimum', `accepted ${totalPaise}`);
  }
});

// ---- 2. Documented statuses and strict parsing ----------------------------
await t('each documented status parses, and the order and amount are NOT read from the reply', () => {
  for (const status of ['SUCCESS', 'PENDING', 'FAILED', 'INVALID', 'NOT_FOUND']) {
    const r = proto.parseVerificationResponse(JSON.stringify({ status, order_id: ORDER, amount: '110.00' }));
    assert.deepStrictEqual(r, { status, orderId: null, amountPaise: null });
  }
});

await t('a status-only SUCCESS can never credit: the classifier refuses it (order-mismatch)', () => {
  const raw = proto.parseVerificationResponse('{"status":"SUCCESS"}');
  const c = ver.classifyGatewayResult(raw, { orderId: ORDER, totalPaise: 11000 });
  assert.strictEqual(c.state, 'unverified');
  assert.strictEqual(c.reason, 'order-mismatch');
});

await t('malformed, non-object, undocumented, or oversized replies are all refused', () => {
  const bad = [
    '', 'not json', '{', '[]', 'null', '"SUCCESS"', '42', '{}',
    '{"status":"success"}', '{"status":"PAID"}', '{"status":5}', '{"status":null}',
    '<html><body>Payment received</body></html>',
  ];
  for (const text of bad) {
    assert.throws(() => proto.parseVerificationResponse(text), 'accepted: ' + text.slice(0, 40));
  }
  assert.throws(() => proto.parseVerificationResponse('{"status":"SUCCESS","pad":"' + 'a'.repeat(70_000) + '"}'),
    (e) => e.code === 'body-too-large');
});

// ---- 3. Redacted summary for the probe ------------------------------------
await t('probe summary lists key names and types only, and never prints values or the key', () => {
  const body = JSON.stringify({ status: 'SUCCESS', api_key: SECRET_KEY, customer_note: 'private text', amount: 110 });
  const out = JSON.stringify(proto.summarizeResponse({ httpStatus: 200, text: body }));
  assert.ok(!out.includes(SECRET_KEY), 'key leaked');
  assert.ok(!out.includes('private text'), 'value leaked');
  assert.ok(out.includes('"status":"SUCCESS"'));
  assert.ok(out.includes('"type":"number"'));
});

await t('probe summary: an undocumented status value is reported as such, not echoed', () => {
  const s = proto.summarizeResponse({ httpStatus: 200, text: '{"status":"PAID-ONLINE-XYZ"}' });
  assert.strictEqual(s.status, '[not a documented status]');
  assert.ok(!JSON.stringify(s).includes('PAID-ONLINE-XYZ'));
});

await t('probe summary: HTML or non-JSON bodies report only their kind and size', () => {
  const s = proto.summarizeResponse({ httpStatus: 403, text: '<html>secret page ' + SECRET_KEY + '</html>' });
  assert.strictEqual(s.json, false);
  assert.strictEqual(s.bodyKind, 'html-or-xml');
  assert.ok(!JSON.stringify(s).includes(SECRET_KEY));
});

// ---- 4. Adapter behaviour with a mocked transport -------------------------
const documented = { ...proto.VC_PROTOCOL_CONTRACT, documented: true };
let calls = 0;
let reply = null;
const transport = async (req) => {
  calls++;
  if (reply instanceof Error) throw reply;
  return reply;
};
const adapter = ad.createVcGatewayAdapter({ contract: documented, transport });
const expected = { orderId: ORDER, totalPaise: 11000 };
const check = () => adapter.checkOrder({ orderId: ORDER, totalPaise: 11000 });

await t('timeout → unavailable, and the error text containing the key is redacted', async () => {
  calls = 0;
  reply = Object.assign(new Error(`The operation was aborted for ${API}?api_key=${SECRET_KEY}`), { name: 'TimeoutError' });
  const r = await check();
  assert.strictEqual(r.state, 'unavailable');
  assert.strictEqual(r.reason, 'network');
  assert.ok(!JSON.stringify(r).includes(SECRET_KEY), 'key leaked into the result');
  assert.strictEqual(calls, 1);
});

await t('HTTP 500 and 301 → unavailable (redirects are never followed)', async () => {
  for (const status of [500, 301, 404]) {
    reply = { status, text: '{"status":"SUCCESS"}' };
    const r = await check();
    assert.strictEqual(r.state, 'unavailable', `status ${status}`);
    assert.strictEqual(r.reason, 'http-status');
  }
});

await t('HTTP 200 with malformed JSON → unverified (never credited)', async () => {
  reply = { status: 200, text: '{"status":"SUCCESS"' };
  const r = await check();
  assert.strictEqual(r.state, 'unverified');
  assert.strictEqual(r.reason, 'malformed');
});

await t('HTTP 200 with an HTML page → unverified', async () => {
  reply = { status: 200, text: '<html>SUCCESS</html>' };
  const r = await check();
  assert.strictEqual(r.state, 'unverified');
});

await t('every documented status reaches the classifier and none credits on its own', async () => {
  const expect = { SUCCESS: 'unverified', PENDING: 'unverified', FAILED: 'unverified', INVALID: 'unverified', NOT_FOUND: 'unverified' };
  for (const [status, want] of Object.entries(expect)) {
    reply = { status: 200, text: JSON.stringify({ status }) };
    const r = await check();
    assert.strictEqual(r.state, 'response', status);
    const c = ver.classifyGatewayResult(r.raw, expected);
    assert.strictEqual(c.state, want, `${status} must not verify without a bound order and amount`);
  }
});

await t('below-minimum totals are refused before any request is sent', async () => {
  calls = 0;
  const r = await adapter.checkOrder({ orderId: ORDER, totalPaise: 50 });
  assert.strictEqual(r.state, 'unverified');
  assert.strictEqual(r.reason, 'below-provider-minimum');
  assert.strictEqual(calls, 0);
});

await t('repeated verification: each attempt is independent and none changes state', async () => {
  calls = 0;
  reply = { status: 200, text: '{"status":"PENDING"}' };
  for (let i = 0; i < 3; i++) {
    const r = await check();
    assert.strictEqual(r.state, 'response');
  }
  assert.strictEqual(calls, 3, 'each verification is a separate, bounded request');
});

// ---- 5. Production gate and wallet state (SQLite) -------------------------
db.prepare('INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, created_at) VALUES (?,?,?,?,?,?,?)')
  .run('vc-protocol@test.dev', 'x', 'client', 'VC Protocol', 0, 0, Date.now());
const uid = db.prepare("SELECT id FROM users WHERE email='vc-protocol@test.dev'").get().id;
const wallet = () => Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(uid).wallet_balance);
const ledger = () => Number(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND type='deposit'").get(uid).n);
const rowOf = (id) => db.prepare('SELECT status FROM inr_deposits WHERE id=?').get(id);

await t('production gate: contract is null, adapter is unconfirmed, and no network call is possible', async () => {
  assert.strictEqual(ad.DOCUMENTED_VERIFICATION_CONTRACT, null);
  assert.strictEqual(ad.productionAdapter.isContractConfirmed, false);
  const r = await ad.productionAdapter.checkOrder({ orderId: ORDER, totalPaise: 11000 });
  assert.strictEqual(r.state, 'unavailable');
  assert.strictEqual(unexpectedFetch, 0);
});

await t('deposit: ₹100 credit creates a PENDING ₹110 order; verification leaves it pending and the wallet unchanged', async () => {
  const out = inr.createInrDeposit({ userId: uid, rupees: '100' });
  assert.ok(out.ok, out.reason);
  const d = out.deposit;
  assert.strictEqual(d.total_paise, 11000);
  assert.strictEqual(d.credit_paise, 10000);
  assert.ok(order.isValidOrderId(d.order_id));
  const before = wallet();
  const ledgerBefore = ledger();
  for (let i = 0; i < 3; i++) {
    const r = await ver.verifyDepositOnce({ depositId: d.id, adapter: ad.productionAdapter });
    assert.strictEqual(r.credited, false);
    assert.strictEqual(r.state, 'unavailable');
  }
  assert.strictEqual(rowOf(d.id).status, 'pending');
  assert.strictEqual(wallet(), before, 'wallet must not change');
  assert.strictEqual(ledger(), ledgerBefore, 'no ledger row');
  assert.strictEqual(unexpectedFetch, 0);
});

await t('concurrent verification of one deposit credits nothing and changes nothing', async () => {
  const d = inr.createInrDeposit({ userId: uid, rupees: '5' }).deposit;
  const before = wallet();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    ver.verifyDepositOnce({ depositId: d.id, adapter: ad.productionAdapter })));
  assert.ok(results.every((r) => r.credited === false));
  assert.strictEqual(rowOf(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});

await t('a plain object claiming a confirmed SUCCESS cannot credit (untrusted verifier)', async () => {
  const d = inr.createInrDeposit({ userId: uid, rupees: '10' }).deposit;
  const before = wallet();
  const fake = {
    isContractConfirmed: true,
    checkOrder: async () => ({ state: 'response', raw: { orderId: d.order_id, status: 'SUCCESS', amountPaise: d.total_paise } }),
  };
  const r = await ver.verifyDepositOnce({ depositId: d.id, adapter: fake });
  assert.strictEqual(r.credited, false);
  assert.strictEqual(r.reason, 'untrusted-verifier');
  assert.strictEqual(rowOf(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});

// ---- 6. UPI URI (QR payload) ----------------------------------------------
await t('QR payload carries the documented fields with the TOTAL and a payee name', () => {
  const uri = order.buildUpiUri({ upiId: 'paytm.s1dw5n5@pty', orderId: ORDER, totalPaise: 11000 });
  assert.strictEqual(uri, `upi://pay?pa=paytm.s1dw5n5@pty&pn=InstaSMM&am=110.00&cu=INR&tn=${ORDER}`);
});

await t('QR payload refuses an injected payee name', () => {
  assert.throws(() => order.buildUpiUri({ upiId: 'paytm.s1dw5n5@pty', orderId: ORDER, totalPaise: 100, payeeName: 'x&am=0' }), /payee/);
});

await t('no test in this suite reached the network', () => {
  assert.strictEqual(unexpectedFetch, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
try { dbm.getDb().close?.(); } catch { /* ignore */ }
try { rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
if (fail > 0) process.exit(1);
