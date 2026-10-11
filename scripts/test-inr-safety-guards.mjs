// ---------------------------------------------------------------------------
// INR gateway safety guards. No network, no database, no provider contract.
//   run: node scripts/test-inr-safety-guards.mjs
//
//   G1  no payment-path file disables TLS certificate verification
//   G2  the production VC Gateway adapter makes ZERO network calls while its
//       contract is unconfirmed, even if a transport is supplied
//   G3  automatic INR crediting is off by configuration and by the gate
//   G4  the INR fee rule: ₹100 credit → ₹10 surcharge → ₹110 total, with the
//       surcharge never added to the wallet credit
//   G5  the deposit credit is computed only from a stored credit amount, and
//       invalid or unsafe amounts are refused
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Empty values stop dotenv (loaded by config.js) from pointing this test at a real database.
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';
process.env.VCGETAWAY_API_KEY = '';

const { createVcGatewayAdapter, productionAdapter, DOCUMENTED_VERIFICATION_CONTRACT } =
  await import('../server/lib/vcGatewayAdapter.js');
const { config } = await import('../server/config.js');
const { automaticCreditingAllowed } = await import('../server/lib/inrVerification.js');
const { inrCreditPaise, inrSurchargePaise, inrTotalPaise } =
  await import('../client/src/lib/inrPayments.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// ---- G1 -------------------------------------------------------------------
// Files that carry payment-provider traffic or INR wallet logic.
const PAYMENT_FILES = [
  'server/lib/vcGatewayAdapter.js',
  'server/lib/inrVerification.js',
  'server/lib/inrDeposits.js',
  'server/lib/inrOrder.js',
  'server/routes/client.inrDeposits.js',
  'server/routes/admin.inrDeposits.js',
  'server/routes/webhooks.js',
];
// Each pattern disables certificate checks in some common way.
const TLS_DISABLE = [
  /rejectUnauthorized\s*:\s*false/i,
  /verify_peer(_name)?"?\s*=>?\s*false/i,
  /NODE_TLS_REJECT_UNAUTHORIZED/,
  /new\s+https\.Agent\s*\(/,
  /strictSSL\s*:\s*false/i,
  /insecure\s*:\s*true/i,
];

await test('G1 no payment-path file disables TLS certificate verification', () => {
  for (const rel of PAYMENT_FILES) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of TLS_DISABLE) {
      assert.ok(!re.test(src), `${rel} matches TLS-disable pattern ${re}`);
    }
  }
});

await test('G1 the adapter refuses redirects, so credentials are never re-sent elsewhere', () => {
  const src = readFileSync(path.join(ROOT, 'server/lib/vcGatewayAdapter.js'), 'utf8');
  assert.ok(src.includes("redirect: 'error'"), 'default transport must use redirect: "error"');
});

// ---- G2 -------------------------------------------------------------------
await test('G2 no contract means checkOrder never calls the transport', async () => {
  assert.strictEqual(DOCUMENTED_VERIFICATION_CONTRACT, null, 'contract must stay null until documented');
  let calls = 0;
  const adapter = createVcGatewayAdapter({
    transport: async () => { calls++; return { status: 200, text: '{}' }; },
  });
  const r = await adapter.checkOrder({ orderId: 'ORD-1', totalPaise: 11000 });
  assert.strictEqual(r.state, 'unavailable');
  assert.strictEqual(r.reason, 'verification-contract-not-confirmed');
  assert.strictEqual(calls, 0, 'no network request may be made without a confirmed contract');
});

await test('G2 the production adapter reports itself unconfirmed', () => {
  assert.strictEqual(productionAdapter.isContractConfirmed, false);
});

// ---- G3 -------------------------------------------------------------------
await test('G3 automatic INR crediting is off by configuration', () => {
  assert.strictEqual(config.vcGetaway.autoCreditEnabled, false);
});

await test('G3 automatic INR crediting is not allowed by the gate', () => {
  assert.strictEqual(automaticCreditingAllowed(productionAdapter), false);
});

// ---- G4 -------------------------------------------------------------------
await test('G4 ₹100 credit → ₹10 surcharge → ₹110 total', () => {
  const credit = inrCreditPaise('100');
  assert.strictEqual(credit, 10000);
  assert.strictEqual(inrSurchargePaise(credit), 1000);
  assert.strictEqual(inrTotalPaise(credit), 11000);
});

await test('G4 the surcharge is never part of the wallet credit (credit + surcharge = total)', () => {
  for (const r of ['1', '2.5', '33.33', '99.99', '250', '1000.01']) {
    const credit = inrCreditPaise(r);
    assert.ok(Number.isSafeInteger(credit), `credit for ${r}`);
    assert.strictEqual(inrTotalPaise(credit) - credit, inrSurchargePaise(credit), `surcharge split for ${r}`);
  }
});

await test('G4 minimum ₹1 credit gives a ₹1.10 total', () => {
  assert.strictEqual(inrTotalPaise(inrCreditPaise('1')), 110);
});

// ---- G5 -------------------------------------------------------------------
await test('G5 invalid or unsafe credit amounts are refused, never rounded silently', () => {
  for (const bad of ['', '0', '-5', '1.234', '1e3', 'abc', '0x10', NaN, Infinity, null, undefined, 1e15]) {
    assert.strictEqual(inrCreditPaise(bad), null, `expected null for ${String(bad)}`);
  }
});

await test('G5 fee helper arithmetic: ₹0.01 credit gives a 1-paise surcharge-free total (surcharge rounds to 0)', () => {
  const credit = inrCreditPaise('0.01');
  assert.strictEqual(credit, 1);
  assert.strictEqual(inrSurchargePaise(credit), 0);
  assert.strictEqual(inrTotalPaise(credit), 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
