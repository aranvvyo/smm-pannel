// ---------------------------------------------------------------------------
// Crypto (Apirone) deposit regression tests. NO network, NO real payments.
//   run: node scripts/test-crypto-deposits.mjs
//
// Uses the REAL server/db.js, server/lib/apirone.js and server/lib/money.js
// against a throwaway SQLite file. Apirone HTTP is mocked via globalThis.fetch.
// The POST /api/deposits body is mirrored here (Express is not loaded).
//
// What this file does NOT prove: SQLite accepts the bare `? IS NOT NULL` that
// PostgreSQL rejects, so the SQL failure itself is NOT reproduced here. The
// PostgreSQL behaviour is checked by scripts/test-crypto-pg-credit.mjs (gated,
// needs a disposable database). This file checks the logic (exactly-once,
// expiry, ledger, small amounts) and carries a static guard against the
// untyped pattern that caused the failure.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(os.tmpdir(), `crypto-deposits-test-${process.pid}.db`);
process.env.DB_FILE = DB_FILE;
process.env.APIRONE_ACCOUNT_ID = 'acct-test';
process.env.APIRONE_TRANSFER_KEY = 'transfer-test-key';
// server/config.js runs `import 'dotenv/config'`, which fills in any key that is
// NOT already set. Deleting DATABASE_URL would let a .env DATABASE_URL (a real
// database) be loaded here. An EMPTY value is already set, so dotenv leaves it
// alone and db.js falls back to the temporary SQLite file.
process.env.DATABASE_URL = '';
process.env.SMM_TEST = '';
process.env.NODE_ENV = '';

// ---- Mocked Apirone (no network) -----------------------------------------
let tickerUsd = 60;
let invoiceSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ticker')) return json({ usd: tickerUsd });
  if (u.includes('/invoices') && opts.method === 'POST') {
    invoiceSeq += 1;
    return json({ id: `INV${invoiceSeq}`, address: `LTCADDR${invoiceSeq}` });
  }
  return json({ error: 'unexpected mock call' }, 404);
};

const dbm = await import(path.join(ROOT, 'server', 'db.js'));
const apir = await import(path.join(ROOT, 'server', 'lib', 'apirone.js'));
const money = await import(path.join(ROOT, 'server', 'lib', 'money.js'));
const db = dbm.getDb();
// Hard stop: this suite must never run against PostgreSQL.
if (db.isPg) throw new Error('test-crypto-deposits must run on the temporary SQLite file, not PostgreSQL');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
  }
}

db.prepare(
  'INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, created_at) VALUES (?,?,?,?,?,?,?)'
).run('crypto-client@test.dev', 'x', 'client', 'Client', 0, 0, Date.now());
const uid = db.prepare("SELECT id FROM users WHERE email='crypto-client@test.dev'").get().id;
const wallet = () => db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(uid).wallet_balance;

// Mirrors POST /api/deposits in server/routes/client.wallet.js.
async function createDeposit(amountUsd, currency = 'LTC') {
  const rate = dbm.getExchangeRate();
  const usdCents = Math.round(amountUsd * 100);
  if (usdCents < 1) throw new Error('route must reject this amount before invoicing');
  const now = Date.now();
  const timeoutHours = Number(db.prepare(`SELECT value FROM settings WHERE key='deposit_timeout_hours'`).get().value || 24);
  const invoice = await apir.createCryptoInvoice({ currency, amountUsd: usdCents });
  const info = db.prepare(
    `INSERT INTO deposits (user_id, invoice_id, currency, currency_code, amount_usd, amount_minor, amount_inr, address, status, is_simulated, created_at, expires_at)
     VALUES (?,?,?,?,?,?,0,?,'pending',?,?,?)`
  ).run(uid, invoice.invoiceId, currency, invoice.currencyCode, usdCents, invoice.amountMinor, invoice.address,
    invoice.simulated ? 1 : 0, now, now + timeoutHours * 3600 * 1000);
  return { id: Number(info.lastInsertRowid), usdCents, rate, invoice };
}

console.log('Crypto deposit regression tests');

await t('invoice creation returns an address and a positive minor amount', async () => {
  const d = await createDeposit(1);
  assert.ok(d.invoice.address.startsWith('LTCADDR'));
  assert.ok(d.invoice.amountMinor > 0);
});

await t('creating an invoice never credits the wallet', () => {
  assert.strictEqual(wallet(), 0);
});

let firstDeposit;
await t('verified webhook slice credits the exact INR amount', () => {
  firstDeposit = db.prepare('SELECT id, amount_minor FROM deposits ORDER BY id DESC LIMIT 1').get();
  const r = apir.creditDeposit(firstDeposit.id, { receivedUsdCents: 100, receivedMinor: firstDeposit.amount_minor, txHash: 'tx-1' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.inr, 10000, '$1.00 at 100 INR/USD = ₹100 = 10000 paise');
  assert.strictEqual(wallet(), 10000);
});

await t('repeated webhook for the same payment is refused (exactly-once)', () => {
  const r = apir.creditDeposit(firstDeposit.id, { receivedUsdCents: 100, receivedMinor: firstDeposit.amount_minor, txHash: 'tx-1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(wallet(), 10000, 'wallet must not be credited twice');
});

await t('small deposit ($0.10) credits exactly ₹10', async () => {
  const d = await createDeposit(0.1);
  const r = apir.creditDeposit(d.id, { receivedUsdCents: 10, receivedMinor: 1, txHash: 'tx-small' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.inr, 1000);
});

await t('admin manual confirm (no received slice) completes a pending invoice exactly once', async () => {
  const d = await createDeposit(5);
  const r = apir.creditDeposit(d.id);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(apir.creditDeposit(d.id).ok, false);
});

await t('an expired pending invoice is never credited', async () => {
  const d = await createDeposit(2);
  db.prepare('UPDATE deposits SET expires_at=? WHERE id=?').run(Date.now() - 1000, d.id);
  const before = wallet();
  const r = apir.creditDeposit(d.id, { receivedUsdCents: 200, receivedMinor: 1, txHash: 'tx-late' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'expired');
  assert.strictEqual(wallet(), before);
});

await t('a dismissed/rejected invoice is never credited', async () => {
  const d = await createDeposit(3);
  db.prepare("UPDATE deposits SET status='rejected' WHERE id=?").run(d.id);
  const before = wallet();
  assert.strictEqual(apir.creditDeposit(d.id).ok, false);
  assert.strictEqual(wallet(), before);
});

await t('every credit writes a matching deposit ledger row', () => {
  const credits = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND type='deposit'").get(uid).n;
  assert.strictEqual(credits, 3, 'three successful credits above -> three ledger rows');
});

await t('wallet balance equals the sum of deposit ledger rows (no drift)', () => {
  const sum = db.prepare("SELECT COALESCE(SUM(amount_inr),0) AS s FROM transactions WHERE user_id=? AND type='deposit'").get(uid).s;
  assert.strictEqual(wallet(), sum);
});

// ---- Static guards (run on any database) ---------------------------------
const apironeSrc = readFileSync(path.join(ROOT, 'server', 'lib', 'apirone.js'), 'utf8');
const walletSrc = readFileSync(path.join(ROOT, 'server', 'routes', 'client.wallet.js'), 'utf8');

await t('credit UPDATE casts untyped parameters for PostgreSQL (no bare "? IS NOT NULL")', () => {
  assert.ok(!/CASE WHEN \?\s+IS NOT NULL/i.test(apironeSrc), 'bare ? IS NOT NULL is untypeable on PostgreSQL');
  assert.ok(/CASE WHEN CAST\(\?\s+AS TEXT\)\s+IS NOT NULL/i.test(apironeSrc));
});

await t('no bare parameter is used only in an IS NULL/CASE test anywhere in crypto SQL', () => {
  const bare = apironeSrc.match(/\?\s*(IS\s+(NOT\s+)?NULL|<>\s*'')/gi) || [];
  assert.deepStrictEqual(bare, [], `untyped parameter(s) found: ${bare.join(', ')}`);
});

await t('deposit route refuses amounts that round to zero cents (no zero-value invoice)', () => {
  assert.ok(/usdCents < 1/.test(walletSrc), 'client.wallet.js must reject usdCents < 1 before creating an invoice');
});

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(DB_FILE, { force: true }); rmSync(DB_FILE + '-wal', { force: true }); rmSync(DB_FILE + '-shm', { force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
