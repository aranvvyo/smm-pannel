// INSTA SMM GATEWAY — order helper + schema tests (no framework, no network).
//   run: node scripts/test-inr-order.mjs
//
// Covers:
//   • server-generated order IDs (format, uniqueness, validation)
//   • the documented UPI URI, amount = TOTAL payable (never the credit)
//   • the 10% fee math, shared with the client (₹100→₹110, ₹500→₹550)
//   • the inr_deposits.order_id column + unique index on the REAL schema,
//     including the upgrade path for databases created before this change
//
// Nothing here calls VC Gateway. Nothing here credits a wallet.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  generateOrderId, isValidOrderId, isValidUpiId, paiseToRupeeString, buildUpiUri, GATEWAY_NAME,
} from '../server/lib/inrOrder.js';
import {
  inrCreditPaise, inrSurchargePaise, inrTotalPaise, MAX_CREDIT_PAISE_EXACT, depositErrorMessage,
} from '../client/src/lib/inrPayments.js';
import { fmtInr } from '../server/lib/money.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPI = 'paytm.s1dw5n0@pty';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  PASS  ${name}`); };

console.log('INSTA SMM GATEWAY — order tests');

t('gateway name is the customer-facing INSTA SMM GATEWAY', () => {
  assert.strictEqual(GATEWAY_NAME, 'INSTA SMM GATEWAY');
});

t('order id matches the documented shape ORD + YYMMDD + 6 chars', () => {
  const id = generateOrderId(new Date('2026-10-08T12:00:00Z'));
  assert.ok(id.startsWith('ORD261008'), id);
  assert.strictEqual(id.length, 15);
  assert.ok(isValidOrderId(id));
});

t('order id is deterministic for a fixed random source (suffix alphabet only)', () => {
  const fixed = () => Buffer.from([0, 1, 2, 3, 4, 5]);
  const id = generateOrderId(new Date('2026-01-02T00:00:00Z'), fixed);
  assert.strictEqual(id, 'ORD260102ABCDEF');
});

t('2,000 generated order ids are all unique and valid', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = generateOrderId();
    assert.ok(isValidOrderId(id), id);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 2000, 'collision in 2000 ids');
});

t('malformed or client-supplied order ids are rejected', () => {
  for (const bad of ['', 'ORD1', 'ORD261008lsw4k4', 'ORD261008LSWA4K; DROP', 'XYZ261008LSWA4K', null, 123]) {
    assert.strictEqual(isValidOrderId(bad), false, `must reject ${String(bad)}`);
  }
});

t('paise → rupee string uses integer math only', () => {
  assert.strictEqual(paiseToRupeeString(11000), '110.00');
  assert.strictEqual(paiseToRupeeString(55000), '550.00');
  assert.strictEqual(paiseToRupeeString(5), '0.05');
  assert.strictEqual(paiseToRupeeString(0), '0.00');
  assert.throws(() => paiseToRupeeString(1.5), /safe integer/);
  assert.throws(() => paiseToRupeeString(-100), /non-negative/);
});

t('UPI URI for ₹100 credit: amount is the ₹110 total, not the ₹100 credit', () => {
  const credit = inrCreditPaise(100);
  const total = inrTotalPaise(credit);
  const uri = buildUpiUri({ upiId: UPI, orderId: 'ORD261008LSWA4K', totalPaise: total });
  assert.strictEqual(uri, `upi://pay?pa=${UPI}&pn=InstaSMM&am=110.00&cu=INR&tn=ORD261008LSWA4K`);
});

t('UPI URI for ₹500 credit: amount is the ₹550 total', () => {
  const total = inrTotalPaise(inrCreditPaise(500));
  const uri = buildUpiUri({ upiId: UPI, orderId: 'ORD261008LSWA4K', totalPaise: total });
  assert.ok(uri.includes('&am=550.00&'), uri);
});

t('UPI URI refuses an invalid UPI id or order id (no injection into the URI)', () => {
  assert.throws(() => buildUpiUri({ upiId: 'x&am=1@pty', orderId: 'ORD261008LSWA4K', totalPaise: 100 }), /UPI/);
  assert.throws(() => buildUpiUri({ upiId: UPI, orderId: 'ORD1&am=0', totalPaise: 100 }), /order/);
  assert.strictEqual(isValidUpiId(UPI), true);
});

t('fee math (shared with the client): ₹100 → fee ₹10 → pay ₹110 → credit ₹100', () => {
  const credit = inrCreditPaise(100);
  assert.strictEqual(credit, 10000);
  assert.strictEqual(inrSurchargePaise(credit), 1000);
  assert.strictEqual(inrTotalPaise(credit), 11000);
});

t('fee math: ₹500 → fee ₹50 → pay ₹550 → credit ₹500', () => {
  const credit = inrCreditPaise(500);
  assert.strictEqual(inrSurchargePaise(credit), 5000);
  assert.strictEqual(inrTotalPaise(credit), 55000);
});

// ---- Schema: inr_deposits.order_id on the real SQL, incl. upgrade path ----
console.log('\nSchema — inr_deposits.order_id');

const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');

// The exact order-id migration db.js runs after the schema on EVERY boot.
function applyOrderIdMigration(db) {
  const have = db.prepare('PRAGMA table_info(inr_deposits)').all().some((c) => c.name === 'order_id');
  if (!have) db.exec('ALTER TABLE inr_deposits ADD COLUMN order_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_order ON inr_deposits(order_id) WHERE order_id IS NOT NULL');
}

t('fresh schema.sql + migration creates inr_deposits with order_id and a unique partial index', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);
  applyOrderIdMigration(db);
  const cols = db.prepare('PRAGMA table_info(inr_deposits)').all().map((c) => c.name);
  assert.ok(cols.includes('order_id'), 'order_id column missing');
  const idx = db.prepare("PRAGMA index_list(inr_deposits)").all().find((i) => i.name === 'idx_inr_deposits_order');
  assert.ok(idx && idx.unique === 1, 'unique index on order_id missing');
  db.close();
});

t('duplicate order_id is refused by the database; NULL order_ids may repeat (legacy rows)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);
  applyOrderIdMigration(db);
  db.exec("INSERT INTO users (email, password_hash, role, name, created_at) VALUES ('a@t.dev','x','client','A',0)");
  const ins = db.prepare(
    'INSERT INTO inr_deposits (user_id, credit_paise, surcharge_paise, total_paise, status, created_at, order_id) VALUES (1,10000,1000,11000,?,0,?)'
  );
  ins.run('pending', 'ORD261008AAAAAA');
  assert.throws(() => ins.run('pending', 'ORD261008AAAAAA'), /UNIQUE/i);
  ins.run('pending', null);
  ins.run('pending', null);   // two legacy/manual rows with no order id are fine
  db.close();
});

t('upgrade path: an old inr_deposits table gains order_id + unique index (db.js migration)', () => {
  const db = new DatabaseSync(':memory:');
  // Old table shape: exactly what existed before order_id.
  db.exec(`CREATE TABLE inr_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    credit_paise INTEGER NOT NULL, surcharge_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', invoice_ref TEXT, payment_ref TEXT, verified_by INTEGER,
    verify_note TEXT, created_at INTEGER NOT NULL, verified_at INTEGER)`);
  // The exact statements db.js ensureColumns runs for this change.
  const have = db.prepare('PRAGMA table_info(inr_deposits)').all().some((c) => c.name === 'order_id');
  if (!have) db.exec('ALTER TABLE inr_deposits ADD COLUMN order_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_order ON inr_deposits(order_id) WHERE order_id IS NOT NULL');
  // Re-running the migration must be harmless (idempotent on every boot).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inr_deposits_order ON inr_deposits(order_id) WHERE order_id IS NOT NULL');
  db.close();
});

// ---- Amount validation, fee at scale, formatting ---------------------------
console.log('\nAmounts, fees and formatting');

t('amounts: plain decimals with at most 2 places are accepted exactly', () => {
  assert.strictEqual(inrCreditPaise('100'), 10000);
  assert.strictEqual(inrCreditPaise('100.5'), 10050);
  assert.strictEqual(inrCreditPaise(100.25), 10025);
  assert.strictEqual(inrCreditPaise('0.01'), 1);
  assert.strictEqual(inrCreditPaise(' 75 '), 7500);
});

t('amounts: booleans, objects, empty, zero, negative, hex, exponent, >2 decimals and non-finite are rejected', () => {
  for (const bad of [true, false, {}, [], '', ' ', 0, '0', -1, '-5', '0x10', '1e3', 1e-7, 100.555, '100.555', '1.', '.5', NaN, Infinity, null, undefined]) {
    assert.strictEqual(inrCreditPaise(bad), null, `must reject ${String(bad)}`);
  }
});

t('amounts: there is no ₹1e9 business cap (₹1,000,000,000 is accepted)', () => {
  assert.strictEqual(inrCreditPaise(1_000_000_000), 100_000_000_000);
  assert.strictEqual(inrCreditPaise('10000000'), 1_000_000_000);   // ₹1 crore
});

t('amounts: the only ceiling is the integer-precision guard, derived from the 10% arithmetic', () => {
  assert.strictEqual(MAX_CREDIT_PAISE_EXACT, Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  const maxWhole = Math.floor(MAX_CREDIT_PAISE_EXACT / 100);
  const top = inrCreditPaise(String(maxWhole));
  assert.strictEqual(top, maxWhole * 100, 'the largest exact amount is accepted');
  assert.strictEqual(inrSurchargePaise(top), top / 10, 'the surcharge stays exact at the top of the range');
  assert.strictEqual(inrCreditPaise(String(maxWhole + 1)), null, 'one rupee past the guard is rejected');
});

t('fee at scale is exact: ₹1,00,00,000 credit → ₹10,00,000 fee → ₹1,10,00,000 payable', () => {
  const credit = inrCreditPaise('10000000');
  assert.strictEqual(inrSurchargePaise(credit), 100_000_000);
  assert.strictEqual(inrTotalPaise(credit), 1_100_000_000);   // ₹1,10,00,000.00
});

t('formatting: normal INR amounts render correctly (server fmtInr, en-IN grouping)', () => {
  assert.strictEqual(fmtInr(10000), '₹100.00');
  assert.strictEqual(fmtInr(11000), '₹110.00');
  assert.strictEqual(fmtInr(110000), '₹1,100.00');
  assert.strictEqual(fmtInr(1000000), '₹10,000.00');
  assert.strictEqual(fmtInr(11000000), '₹1,10,000.00');
});

t('formatting: the client formatter uses the same en-IN grouping (ui.jsx)', () => {
  const ui = readFileSync(path.join(ROOT, 'client', 'src', 'ui.jsx'), 'utf8');
  assert.ok(/fmtInr = \(paise, digits = 2\) =>[\s\S]*'en-IN'/.test(ui), 'client fmtInr must use en-IN');
});

t('documented limits: the deposit page shows the ₹1.00 minimum and no maximum', () => {
  const page = readFileSync(path.join(ROOT, 'client', 'src', 'pages', 'client', 'VcDeposit.jsx'), 'utf8');
  assert.ok(page.includes('Minimum deposit ₹1.00. No maximum deposit limit. A 10% customer surcharge is added to your payment.'),
    'the exact limit text must be shown');
  assert.ok(page.includes('INR_MIN_CREDIT_PAISE'), 'the page must enforce the shared minimum');
  assert.ok(!page.includes('MAX_RUPEES'), 'the old cap constant must be gone');
  assert.ok(!/up to \{fmtInr/.test(page), 'no numeric maximum may be rendered');
});

// ---- Error messages ----------------------------------------------------------
console.log('\nError messages');

t('a catch-all 404 ("Not found.") becomes a clear service message, never the raw text', () => {
  const msg = depositErrorMessage({ status: 404, message: 'Not found.' });
  assert.notStrictEqual(msg, 'Not found.');
  assert.ok(/isn't available/.test(msg), msg);
});

t('specific server messages are kept (a real "Deposit not found." is not hidden)', () => {
  assert.strictEqual(depositErrorMessage({ status: 404, message: 'Deposit not found.' }), 'Deposit not found.');
  assert.strictEqual(depositErrorMessage({ status: 400, message: 'This deposit is no longer pending.' }),
    'This deposit is no longer pending.');
});

t('a network failure (no HTTP status) gets a connection message', () => {
  assert.ok(/Network error/.test(depositErrorMessage(new TypeError('Failed to fetch'))));
});

t('5xx responses never leak internal detail', () => {
  const msg = depositErrorMessage({ status: 500, message: 'SQLITE_ERROR: no such table: inr_deposits' });
  assert.ok(!/SQLITE|inr_deposits|no such/.test(msg), msg);
});

t('auth failures ask the user to sign in; generic failures get a safe fallback', () => {
  assert.ok(/sign in/i.test(depositErrorMessage({ status: 401, message: 'Unauthorized' })));
  assert.strictEqual(depositErrorMessage({ status: 400, message: 'Request failed.' }),
    'Something went wrong. Please try again.');
  assert.strictEqual(depositErrorMessage(null), 'Something went wrong. Please try again.');
});

// ---- Route registration (the root cause of "Not found.") ---------------------
console.log('\nRoute registration');

const indexSrc = readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

t('client INR router is imported and mounted BEFORE the wallet router', () => {
  assert.ok(indexSrc.includes("import clientInrDepositRoutes from './routes/client.inrDeposits.js'"), 'import missing');
  const mount = indexSrc.indexOf("app.use('/api/deposits/inr', clientInrDepositRoutes)");
  const wallet = indexSrc.indexOf("app.use('/api', clientWalletRoutes)");
  assert.ok(mount > 0, 'client INR router is never mounted (requests fall through to "Not found.")');
  assert.ok(wallet > mount, 'must be mounted before the wallet router');
});

t('admin INR router is imported and mounted BEFORE the general deposits router', () => {
  assert.ok(indexSrc.includes("import adminInrDepositRoutes from './routes/admin.inrDeposits.js'"), 'import missing');
  const mount = indexSrc.indexOf("app.use('/api/admin/deposits/inr', adminInrDepositRoutes)");
  const general = indexSrc.indexOf("app.use('/api/admin/deposits', depositsRouter)");
  assert.ok(mount > 0, 'admin INR router is never mounted');
  assert.ok(general > mount, 'must be mounted before the general deposits router');
});

console.log(`\n${pass} tests passed`);
