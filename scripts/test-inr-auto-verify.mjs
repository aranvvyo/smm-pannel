// ---------------------------------------------------------------------------
// Automatic INR verification tests. MOCKED gateway only: no network, no real
// payments, no production data.
//   run: node scripts/test-inr-auto-verify.mjs
//
// The provider contract used here is a MOCK that exists only inside this file.
// It proves the wallet logic, not the real VC Gateway behaviour, which is still
// undocumented. Nothing here is evidence that production verification works.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `inr-auto-verify-test-${process.pid}.db`);
const FAKE_KEY = 'TEST-ONLY-KEY-do-not-use-9f8e7d';
process.env.DB_FILE = DB_FILE;
process.env.VCGETAWAY_API_KEY = FAKE_KEY;
// Empty values stop dotenv (loaded by config.js) from pointing this test at a real database.
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
// TEST-ONLY hook: appends a mock-verifier factory to vcGatewayAdapter.js in
// memory for this process. The production source has no such seam.
{
  const { register } = await import('node:module');
  register('./support/trusted-verifier-loader.mjs', import.meta.url);
}

// Forbid any real network call from this suite.
let unexpectedFetch = 0;
globalThis.fetch = async () => { unexpectedFetch++; throw new Error('network disabled in tests'); };

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const { config } = await import(path.join(ROOT, 'server', 'config.js'));
const inr = await import(path.join(ROOT, 'server', 'lib', 'inrDeposits.js'));
const ver = await import(path.join(ROOT, 'server', 'lib', 'inrVerification.js'));
const ad = await import(path.join(ROOT, 'server', 'lib', 'vcGatewayAdapter.js'));
const db = dbm.getDb();
if (db.isPg) throw new Error('test-inr-auto-verify must run on the temporary SQLite file, not PostgreSQL');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0,6).join(" / ")}`); }
}

// ---- Mock provider contract (test-only) ----------------------------------
let transportCalls = 0;
let nextReply = null;           // { status, text } or an Error to throw
const mockContract = {
  documented: true,
  buildRequest: ({ orderId, totalPaise }) => ({
    method: 'GET',
    url: `https://mock.invalid/payment_api.php?api_key=${FAKE_KEY}&order_id=${orderId}&amount=${totalPaise}`,
  }),
  parseResponse: (text) => {
    const o = JSON.parse(text);                // throws on malformed JSON
    return { orderId: o.order_id, status: o.status, amountPaise: o.amount_paise };
  },
};
const mockTransport = async () => {
  transportCalls++;
  if (nextReply instanceof Error) throw nextReply;
  return nextReply;
};
const mockAdapter = ad.__createTestVerifier({ contract: mockContract, transport: mockTransport });
const reply = (obj) => { nextReply = { status: 200, text: JSON.stringify(obj) }; };

// ---- Fixtures -------------------------------------------------------------
db.prepare('INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, created_at) VALUES (?,?,?,?,?,?,?)')
  .run('inr-auto@test.dev', 'x', 'client', 'INR Auto', 0, 0, Date.now());
const uid = db.prepare("SELECT id FROM users WHERE email='inr-auto@test.dev'").get().id;
const wallet = () => db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(uid).wallet_balance;
const row = (id) => db.prepare('SELECT * FROM inr_deposits WHERE id=?').get(id);
const newDeposit = (rupees) => {
  const out = inr.createInrDeposit({ userId: uid, rupees: String(rupees) });
  assert.ok(out.ok, `createInrDeposit(${rupees}) failed: ${out.reason}`);
  return out.deposit;
};
const ledgerCount = () => db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND type='deposit'").get(uid).n;
const setAutoCredit = (on) => { config.vcGetaway.autoCreditEnabled = on; };

console.log('INR automatic verification tests (mocked gateway)');

// ---- Classification (pure) ------------------------------------------------
const exp = { orderId: 'ORD261010ABCDEF', totalPaise: 11000 };
await t('SUCCESS with matching order and total is verified', () => {
  assert.strictEqual(ver.classifyGatewayResult({ orderId: exp.orderId, status: 'SUCCESS', amountPaise: 11000 }, exp).state, 'verified');
});
await t('PENDING, FAILED, INVALID and NOT_FOUND never verify', () => {
  for (const [s, want] of [['PENDING', 'pending'], ['FAILED', 'failed'], ['INVALID', 'invalid'], ['NOT_FOUND', 'not_found']]) {
    assert.strictEqual(ver.classifyGatewayResult({ orderId: exp.orderId, status: s, amountPaise: 11000 }, exp).state, want);
  }
});
await t('unknown status is unverified, never success', () => {
  assert.strictEqual(ver.classifyGatewayResult({ orderId: exp.orderId, status: 'PAID', amountPaise: 11000 }, exp).state, 'unverified');
  assert.strictEqual(ver.classifyGatewayResult({ orderId: exp.orderId, status: 'success', amountPaise: 11000 }, exp).state, 'unverified');
});
await t('wrong order id is unverified even when SUCCESS', () => {
  const c = ver.classifyGatewayResult({ orderId: 'ORD261010ZZZZZZ', status: 'SUCCESS', amountPaise: 11000 }, exp);
  assert.deepStrictEqual(c, { state: 'unverified', reason: 'order-mismatch' });
});
await t('amount equal to the CREDIT (not the total) is unverified', () => {
  const c = ver.classifyGatewayResult({ orderId: exp.orderId, status: 'SUCCESS', amountPaise: 10000 }, exp);
  assert.deepStrictEqual(c, { state: 'unverified', reason: 'amount-mismatch' });
});
await t('malformed or missing reply is unverified', () => {
  for (const raw of [null, undefined, 'SUCCESS', 42, {}, { orderId: exp.orderId, status: 'SUCCESS' }]) {
    assert.strictEqual(ver.classifyGatewayResult(raw, exp).state, 'unverified');
  }
});

// ---- Adapter -------------------------------------------------------------
await t('production adapter has no contract: unavailable with NO network call', async () => {
  const before = unexpectedFetch;
  const out = await ad.productionAdapter.checkOrder({ orderId: exp.orderId, totalPaise: 11000 });
  assert.deepStrictEqual(out, { state: 'unavailable', reason: 'verification-contract-not-confirmed' });
  assert.strictEqual(unexpectedFetch, before);
});
await t('amount below the documented ₹1 minimum is not sent to the gateway', async () => {
  const before = transportCalls;
  const out = await mockAdapter.checkOrder({ orderId: exp.orderId, totalPaise: 99 });
  assert.strictEqual(out.state, 'unverified');
  assert.strictEqual(out.reason, 'below-provider-minimum');
  assert.strictEqual(transportCalls, before);
});
await t('gateway timeout or network failure is unavailable and secret-free', async () => {
  nextReply = new Error(`fetch failed: https://mock.invalid/payment_api.php?api_key=${FAKE_KEY}&order_id=x`);
  const out = await mockAdapter.checkOrder({ orderId: exp.orderId, totalPaise: 11000 });
  assert.strictEqual(out.state, 'unavailable');
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY), 'API key leaked into adapter result');
});
await t('HTTP error status is unavailable, not a success', async () => {
  nextReply = { status: 503, text: '{"status":"SUCCESS"}' };
  const out = await mockAdapter.checkOrder({ orderId: exp.orderId, totalPaise: 11000 });
  assert.strictEqual(out.state, 'unavailable');
});
await t('malformed JSON from the gateway is unverified, not thrown', async () => {
  nextReply = { status: 200, text: '<html>oops' };
  const out = await mockAdapter.checkOrder({ orderId: exp.orderId, totalPaise: 11000 });
  assert.deepStrictEqual(out, { state: 'unverified', reason: 'malformed' });
});
await t('redaction removes the key from logged or returned text', () => {
  const s = ad.redactSecrets(`GET https://x/payment_api.php?api_key=${FAKE_KEY}&order_id=1`);
  assert.ok(!s.includes(FAKE_KEY));
  assert.ok(s.includes('[REDACTED]'));
});

// ---- Deposit creation and amounts ----------------------------------------
await t('₹100 request creates a deposit: credit ₹100, total ₹110, unique ORD order id', () => {
  const d = newDeposit(100);
  assert.strictEqual(Number(d.credit_paise), 10000);
  assert.strictEqual(Number(d.total_paise), 11000);
  assert.ok(/^ORD\d{6}[A-Z2-9]{6}$/.test(d.order_id));
});
await t('amounts that round to zero paise are rejected by the shared parser', () => {
  assert.strictEqual(inr.createInrDeposit({ userId: uid, rupees: '0.001' }).ok, false);
  assert.strictEqual(inr.createInrDeposit({ userId: uid, rupees: '0' }).ok, false);
});
await t('a sub-₹1 credit is rejected at creation: no row, no gateway call', () => {
  const before = transportCalls;
  const count = db.prepare('SELECT COUNT(*) AS n FROM inr_deposits').get().n;
  const out = inr.createInrDeposit({ userId: uid, rupees: '0.5' });
  assert.deepStrictEqual(out, { ok: false, reason: 'below-minimum' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM inr_deposits').get().n, count);
  assert.strictEqual(transportCalls, before);
});
await t('a ₹1.00 credit is accepted (documented minimum, inclusive)', () => {
  const d = newDeposit(1);
  assert.strictEqual(d.credit_paise, 100);
  assert.strictEqual(d.total_paise, 110);
});

// ---- Verification outcomes (flag off, so nothing can credit) -------------
await t('PENDING payment: status unchanged, no credit, deposit checked again later', async () => {
  const d = newDeposit(100);
  reply({ order_id: d.order_id, status: 'PENDING', amount_paise: 11000 });
  const before = wallet();
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  assert.strictEqual(out.state, 'pending');
  assert.strictEqual(out.credited, false);
  assert.strictEqual(row(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});
await t('FAILED, INVALID and NOT_FOUND never credit and leave the row unchanged', async () => {
  for (const status of ['FAILED', 'INVALID', 'NOT_FOUND']) {
    const d = newDeposit(100);
    reply({ order_id: d.order_id, status, amount_paise: 11000 });
    const before = wallet();
    const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
    assert.strictEqual(out.credited, false, status);
    assert.strictEqual(row(d.id).status, 'pending', status);
    assert.strictEqual(wallet(), before, status);
  }
});
await t('wrong order id in a SUCCESS reply does not credit', async () => {
  const d = newDeposit(100);
  reply({ order_id: 'ORD261010WRONG1', status: 'SUCCESS', amount_paise: 11000 });
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  assert.strictEqual(out.state, 'unverified');
  assert.strictEqual(row(d.id).status, 'pending');
});
await t('wrong amount in a SUCCESS reply does not credit (short, over, or credit-only)', async () => {
  setAutoCredit(true);
  for (const amt of [10000, 10999, 11001, 0]) {
    const d = newDeposit(100);
    reply({ order_id: d.order_id, status: 'SUCCESS', amount_paise: amt });
    const before = wallet();
    const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
    assert.strictEqual(out.credited, false, `amount ${amt}`);
    assert.strictEqual(wallet(), before, `amount ${amt}`);
  }
  setAutoCredit(false);
});
await t('malformed reply, timeout and unavailable gateway leave the wallet unchanged', async () => {
  setAutoCredit(true);
  const d = newDeposit(100);
  const before = wallet();
  nextReply = { status: 200, text: 'not json' };
  assert.strictEqual((await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter })).credited, false);
  nextReply = new Error('timeout');
  assert.strictEqual((await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter })).credited, false);
  assert.strictEqual(row(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
  setAutoCredit(false);
});

// ---- Crediting -----------------------------------------------------------
await t('verified SUCCESS is NOT credited while autoCreditEnabled is false', async () => {
  const d = newDeposit(100);
  reply({ order_id: d.order_id, status: 'SUCCESS', amount_paise: 11000 });
  const before = wallet();
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  assert.strictEqual(out.state, 'verified-credit-disabled');
  assert.strictEqual(out.credited, false);
  assert.strictEqual(row(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});
await t('verified SUCCESS with the switch on credits exactly the ₹100 CREDIT, once', async () => {
  const d = newDeposit(100);
  reply({ order_id: d.order_id, status: 'SUCCESS', amount_paise: 11000 });
  const before = wallet();
  const ledgerBefore = ledgerCount();
  setAutoCredit(true);
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  setAutoCredit(false);
  assert.strictEqual(out.state, 'verified');
  assert.strictEqual(out.credited, true);
  assert.strictEqual(row(d.id).status, 'verified');
  assert.strictEqual(wallet(), before + 10000, 'wallet must increase by ₹100, not ₹110');
  assert.strictEqual(ledgerCount(), ledgerBefore + 1);
});
await t('duplicate verification of a credited deposit makes no provider call and no credit', async () => {
  setAutoCredit(true);
  const d = newDeposit(100);
  reply({ order_id: d.order_id, status: 'SUCCESS', amount_paise: 11000 });
  await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  const before = wallet();
  const calls = transportCalls;
  const again = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  setAutoCredit(false);
  assert.strictEqual(again.state, 'terminal');
  assert.strictEqual(transportCalls, calls, 'credited deposit must not be re-sent to the provider');
  assert.strictEqual(wallet(), before);
});
await t('concurrent verifications of one deposit credit it exactly once', async () => {
  setAutoCredit(true);
  const d = newDeposit(100);
  reply({ order_id: d.order_id, status: 'SUCCESS', amount_paise: 11000 });
  const before = wallet();
  const [a, b] = await Promise.all([
    ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter }),
    ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter }),
  ]);
  setAutoCredit(false);
  assert.strictEqual([a.credited, b.credited].filter(Boolean).length, 1, 'exactly one of two must credit');
  assert.strictEqual(wallet(), before + 10000);
});
// A reply the trusted adapter parses itself: the only kind issuance accepts.
const adapterReply = async (orderId, totalPaise, status, amountPaise = totalPaise) => {
  nextReply = { status: 200, text: JSON.stringify({ order_id: orderId, status, amount_paise: amountPaise }) };
  const c = await mockAdapter.checkOrder({ orderId, totalPaise });
  assert.strictEqual(c.state, 'response', `checkOrder must return a response, got ${c.state}`);
  return c.raw;
};
// Credit requires a token minted by issueVerification() for the same order.
const tokenFor = async (orderId, totalPaise, status = 'SUCCESS', amountPaise = totalPaise) => {
  const raw = await adapterReply(orderId, totalPaise, status, amountPaise);
  const iv = ver.issueVerification({ adapter: mockAdapter, expected: { orderId, totalPaise }, raw });
  assert.ok(iv.ok, `issueVerification failed: ${iv.reason}`);
  return iv.token;
};
await t('a forged or hand-built verification object cannot credit', () => {
  const d = newDeposit(100);
  setAutoCredit(true);
  const forged = { orderId: d.order_id, totalPaise: 11000 };
  const out = ver.creditVerifiedInrDeposit({ depositId: d.id, verification: forged });
  setAutoCredit(false);
  assert.deepStrictEqual(out, { ok: false, reason: 'no-verification' });
  assert.strictEqual(row(d.id).status, 'pending');
});
await t('issueVerification refuses without a confirmed contract', () => {
  const d = newDeposit(100);
  const iv = ver.issueVerification({
    adapter: ad.productionAdapter,
    expected: { orderId: d.order_id, totalPaise: 11000 },
    raw: { orderId: d.order_id, status: 'SUCCESS', amountPaise: 11000 },
  });
  assert.deepStrictEqual(iv, { ok: false, reason: 'contract-unconfirmed' });
});
await t('creditVerifiedInrDeposit refuses a token issued for a different order', async () => {
  const d = newDeposit(100);
  setAutoCredit(true);
  const out = ver.creditVerifiedInrDeposit({ depositId: d.id, verification: await tokenFor('ORD261010WRONG1', 11000) });
  setAutoCredit(false);
  assert.deepStrictEqual(out, { ok: false, reason: 'order-mismatch' });
  assert.strictEqual(row(d.id).status, 'pending');
});
await t('creditVerifiedInrDeposit refuses a token whose total differs from the stored total', async () => {
  const d = newDeposit(100);
  setAutoCredit(true);
  const out = ver.creditVerifiedInrDeposit({ depositId: d.id, verification: await tokenFor(d.order_id, 10000) });
  setAutoCredit(false);
  assert.deepStrictEqual(out, { ok: false, reason: 'amount-mismatch' });
  assert.strictEqual(row(d.id).status, 'pending');
});
await t('a failed ledger write rolls back the status flip and the credit completely', async () => {
  const d = newDeposit(100);
  const before = wallet();
  const ledgerBefore = ledgerCount();
  setAutoCredit(true);
  const tok = await tokenFor(d.order_id, 11000);
  db.exec("CREATE TRIGGER inr_fail_ledger BEFORE INSERT ON transactions WHEN NEW.type='deposit' BEGIN SELECT RAISE(ABORT,'forced failure'); END");
  try {
    assert.throws(() => ver.creditVerifiedInrDeposit({ depositId: d.id, verification: tok }), /forced failure/);
  } finally {
    db.exec('DROP TRIGGER inr_fail_ledger');
    setAutoCredit(false);
  }
  assert.strictEqual(row(d.id).status, 'pending', 'status must be rolled back');
  assert.strictEqual(wallet(), before, 'wallet must be rolled back');
  assert.strictEqual(ledgerCount(), ledgerBefore, 'no ledger row may remain');
});

// ---- Poller and config safety --------------------------------------------
await t('poller never starts while the contract is unconfirmed or the switch is off', () => {
  setAutoCredit(true);
  assert.strictEqual(ver.startInrVerificationPoller({ adapter: ad.productionAdapter }), null);
  setAutoCredit(false);
  assert.strictEqual(ver.startInrVerificationPoller({ adapter: mockAdapter }), null);
});
await t('batch only touches live pending deposits that have an order id', async () => {
  const d = newDeposit(100);
  db.prepare("UPDATE inr_deposits SET status='denied' WHERE id=?").run(d.id);  // terminal: must be skipped
  const legacy = db.prepare(
    `INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, created_at) VALUES (?,?,?,?,'pending',?)`
  ).run(uid, 10000, 1000, 11000, Date.now());                                    // no order id: skipped
  reply({ order_id: 'x', status: 'PENDING', amount_paise: 1 });
  const before = transportCalls;
  const results = await ver.verifyPendingBatch({ adapter: mockAdapter, batch: 500 });
  assert.ok(!results.some((r) => r.state === 'terminal' || r.state === 'error'));
  assert.ok(transportCalls >= before);
  assert.strictEqual(row(Number(legacy.lastInsertRowid)).status, 'pending');
});
await t('wallet equals the sum of this user’s deposit ledger rows (no drift)', () => {
  const sum = db.prepare("SELECT COALESCE(SUM(amount_inr),0) AS s FROM transactions WHERE user_id=? AND type='deposit'").get(uid).s;
  assert.strictEqual(wallet(), sum);
});
await t('no request reached the real network during the suite', () => {
  assert.strictEqual(unexpectedFetch, 0);
});

// ---- Task 2: trusted verifier only, no forged tokens ----------------------
await t('a plain object claiming a confirmed contract cannot mint a token', () => {
  const fake = { isContractConfirmed: true, checkOrder: async () => ({ state: 'response', raw: {} }) };
  const iv = ver.issueVerification({ adapter: fake, expected: exp, raw: { orderId: exp.orderId, status: 'SUCCESS', amountPaise: 11000 } });
  assert.deepStrictEqual(iv, { ok: false, reason: 'untrusted-verifier' });
});
await t('an adapter built by the public constructor is not trusted, even with a mock contract', () => {
  const plain = ad.createVcGatewayAdapter({ contract: mockContract, transport: mockTransport });
  assert.strictEqual(ad.isTrustedVerifier(plain), false);
  assert.strictEqual(ad.isTrustedVerifier(mockAdapter), true);
  assert.strictEqual(ad.isTrustedVerifier(ad.productionAdapter), true);
});
await t('verifyDepositOnce with a fake adapter never calls its checkOrder and never credits, even with the switch on', async () => {
  const d = newDeposit(100);
  let spyCalls = 0;
  const fake = {
    isContractConfirmed: true,
    checkOrder: async () => { spyCalls++; return { state: 'response', raw: { orderId: d.order_id, status: 'SUCCESS', amountPaise: 11000 } }; },
  };
  const before = wallet();
  setAutoCredit(true);
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: fake });
  setAutoCredit(false);
  assert.deepStrictEqual(out, { state: 'unverified', reason: 'untrusted-verifier', credited: false });
  assert.strictEqual(spyCalls, 0, 'a fake adapter must not be asked');
  assert.strictEqual(row(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});
await t('a SUCCESS for the wrong order, parsed by the trusted adapter, is refused', async () => {
  const raw = await adapterReply('ORD261010WRONG1', 11000, 'SUCCESS');
  const iv = ver.issueVerification({ adapter: mockAdapter, expected: exp, raw });
  assert.deepStrictEqual(iv, { ok: false, reason: 'order-mismatch' });
});
await t('a reply object built by the caller is refused even through the trusted verifier', () => {
  const forged = { orderId: exp.orderId, status: 'SUCCESS', amountPaise: 11000 };
  const iv = ver.issueVerification({ adapter: mockAdapter, expected: exp, raw: forged });
  assert.deepStrictEqual(iv, { ok: false, reason: 'untrusted-reply' });
});
await t('positive control: a SUCCESS parsed by the trusted adapter credits exactly once (no forgery needed)', async () => {
  const d = newDeposit(100);
  nextReply = { status: 200, text: JSON.stringify({ order_id: d.order_id, status: 'SUCCESS', amount_paise: 11000 }) };
  setAutoCredit(true);
  const before = wallet();
  const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: mockAdapter });
  setAutoCredit(false);
  assert.strictEqual(out.credited, true);
  assert.strictEqual(wallet(), before + 10000);
});
// The REAL documented protocol contract (status-only replies, no order or amount
// fields) through the trusted verifier. This is what production would run, so a
// bare SUCCESS must never credit, even with the switch on.
{
  const { VC_PROTOCOL_CONTRACT } = await import(path.join(ROOT, 'server', 'lib', 'vcGatewayProtocol.js'));
  const sent = [];
  let protoReply = null;
  const protoTransport = async (req) => {
    sent.push(req.url);
    return protoReply;
  };
  const protoAdapter = ad.__createTestVerifier({
    contract: { ...VC_PROTOCOL_CONTRACT, documented: true },
    transport: protoTransport,
  });

  await t('documented protocol: a status-only SUCCESS is refused and credits nothing, even with the switch on', async () => {
    const d = newDeposit(100);
    protoReply = { status: 200, text: '{"status":"SUCCESS"}' };
    const before = wallet();
    const ledgerBefore = ledgerCount();
    setAutoCredit(true);
    const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: protoAdapter });
    setAutoCredit(false);
    assert.strictEqual(out.credited, false);
    assert.strictEqual(out.state, 'unverified');
    assert.strictEqual(out.reason, 'order-mismatch', 'a bare status cannot bind to the order');
    assert.strictEqual(row(d.id).status, 'pending');
    assert.strictEqual(wallet(), before);
    assert.strictEqual(ledgerCount(), ledgerBefore);
  });

  await t('documented protocol: PENDING, FAILED, INVALID and NOT_FOUND never credit, even with the switch on', async () => {
    setAutoCredit(true);
    try {
      for (const status of ['PENDING', 'FAILED', 'INVALID', 'NOT_FOUND']) {
        const d = newDeposit(100);
        protoReply = { status: 200, text: JSON.stringify({ status }) };
        const before = wallet();
        const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: protoAdapter });
        assert.strictEqual(out.credited, false, status);
        assert.strictEqual(row(d.id).status, 'pending', status);
        assert.strictEqual(wallet(), before, status);
      }
    } finally {
      setAutoCredit(false);
    }
  });

  await t('documented protocol: the request goes only to the documented host, path and parameters', async () => {
    const d = newDeposit(100);
    protoReply = { status: 200, text: '{"status":"PENDING"}' };
    sent.length = 0;
    await ver.verifyDepositOnce({ depositId: d.id, adapter: protoAdapter });
    assert.strictEqual(sent.length, 1, 'exactly one provider request');
    const u = new URL(sent[0]);
    assert.strictEqual(u.origin + u.pathname, 'https://vcgatewaypro.com/payment_api.php');
    assert.strictEqual(u.searchParams.get('order_id'), d.order_id);
    assert.strictEqual(u.searchParams.get('amount'), '110.00', 'total payable, not the ₹100 credit');
  });

  await t('documented protocol: a duplicate verification after a refused SUCCESS still never credits', async () => {
    const d = newDeposit(100);
    protoReply = { status: 200, text: '{"status":"SUCCESS"}' };
    const before = wallet();
    setAutoCredit(true);
    try {
      for (let i = 0; i < 3; i++) {
        const out = await ver.verifyDepositOnce({ depositId: d.id, adapter: protoAdapter });
        assert.strictEqual(out.credited, false);
      }
    } finally {
      setAutoCredit(false);
    }
    assert.strictEqual(wallet(), before);
    assert.strictEqual(row(d.id).status, 'pending');
  });
}

await t('a SUCCESS with the wrong amount, parsed by the trusted adapter, is refused', async () => {
  for (const amountPaise of [10000, 11001, 0]) {
    const raw = await adapterReply(exp.orderId, 11000, 'SUCCESS', amountPaise);
    const iv = ver.issueVerification({ adapter: mockAdapter, expected: exp, raw });
    assert.deepStrictEqual(iv, { ok: false, reason: 'amount-mismatch' }, `amount ${amountPaise}`);
  }
});
await t('a token issued for a deposit cannot credit while the switch is off', async () => {
  const d = newDeposit(100);
  const tok = await tokenFor(d.order_id, 11000);
  setAutoCredit(false);
  const before = wallet();
  assert.deepStrictEqual(ver.creditVerifiedInrDeposit({ depositId: d.id, verification: tok }), { ok: false, reason: 'auto-credit-disabled' });
  assert.strictEqual(row(d.id).status, 'pending');
  assert.strictEqual(wallet(), before);
});
await t('the production adapter source has no test seam, env flag, or registration export', () => {
  const src = readFileSync(path.join(ROOT, 'server', 'lib', 'vcGatewayAdapter.js'), 'utf8');
  assert.ok(!src.includes('createTestVerifier'), 'no factory name in production source');
  assert.ok(!src.includes('__createTestVerifier'), 'no injected seam name in production source');
  assert.ok(!src.includes('INR_VERIFIER_TEST_SEAM'), 'no environment switch in production source');
  assert.ok(!/export function (register|add|trust)\w*\(/.test(src), 'no exported registration function');
});
await t('no production code path imports the test seam or the loader', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.(m?js|jsx)$/.test(f.name)) {
        const body = readFileSync(full, 'utf8');
        if (body.includes('__createTestVerifier') || body.includes('trusted-verifier-loader')) offenders.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  walk(path.join(ROOT, 'client', 'src'));
  assert.deepStrictEqual(offenders, []);
});

// ---- Task 1: poller survives database failure -----------------------------
const captureErrors = () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(' '));
  return { lines, restore: () => { console.error = orig; } };
};
let unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on('unhandledRejection', onUnhandled);
const hideTable = () => db.exec('ALTER TABLE inr_deposits RENAME TO inr_deposits_hidden');
const showTable = () => db.exec('ALTER TABLE inr_deposits_hidden RENAME TO inr_deposits');

await t('a database error in a poll pass is caught, redacted, and reported (no rejection)', async () => {
  const cap = captureErrors();
  hideTable();
  let r;
  try { r = await ver.runInrPollOnce({ adapter: mockAdapter }); }
  finally { showTable(); cap.restore(); }
  assert.deepStrictEqual(r, { error: 'poll-failed' });
  assert.ok(cap.lines.length >= 1, 'the failure must be logged');
  assert.ok(!cap.lines.join('\n').includes(FAKE_KEY), 'the log must not contain the key');
  assert.strictEqual(unhandled, 0, 'no unhandled promise rejection');
});
await t('after a failed pass the next pass runs normally (flag cleared, results returned)', async () => {
  const r = await ver.runInrPollOnce({ adapter: mockAdapter });
  assert.ok(Array.isArray(r.results), 'a normal pass returns results');
  assert.strictEqual(r.skipped, undefined);
});
await t('overlapping passes in one process: the second is skipped, the first completes', async () => {
  const [a, b] = await Promise.all([
    ver.runInrPollOnce({ adapter: mockAdapter }),
    ver.runInrPollOnce({ adapter: mockAdapter }),
  ]);
  assert.ok(Array.isArray(a.results) !== Array.isArray(b.results), 'exactly one pass runs');
  assert.strictEqual([a, b].filter((x) => x.skipped === 'overlap').length, 1);
});
await t('the interval poller keeps running after failed ticks and processes deposits again', async () => {
  const pending = newDeposit(100);
  reply({ order_id: pending.order_id, status: 'PENDING', amount_paise: 11000 }); // never credits
  const cap = captureErrors();
  const walletBefore = wallet();
  setAutoCredit(true);
  const timer = ver.startInrVerificationPoller({ adapter: mockAdapter, intervalMs: 10 });
  let calls;
  try {
    assert.ok(timer, 'poller must start with a trusted, confirmed verifier and the switch on');
    hideTable();
    await new Promise((res) => setTimeout(res, 60));    // several failing ticks
    showTable();
    calls = transportCalls;
    await new Promise((res) => setTimeout(res, 80));    // ticks must succeed again
  } finally {
    clearInterval(timer);
    setAutoCredit(false);
    cap.restore();
  }
  assert.ok(transportCalls > calls, 'ticks after the failure must reach the provider again');
  assert.strictEqual(wallet(), walletBefore, 'a PENDING reply must not credit');
  assert.strictEqual(row(pending.id).status, 'pending');
  assert.ok(cap.lines.length >= 1, 'failed ticks must be logged');
  assert.ok(!cap.lines.join('\n').includes(FAKE_KEY), 'logs must not contain the key');
  assert.strictEqual(unhandled, 0, 'no unhandled promise rejection from the interval poller');
});
process.off('unhandledRejection', onUnhandled);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(DB_FILE, { force: true }); rmSync(DB_FILE + '-wal', { force: true }); rmSync(DB_FILE + '-shm', { force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
