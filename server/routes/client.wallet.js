import { Router } from 'express';
import { getDb, getExchangeRate, getSetting } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { usdToInr, inrToUsd, fmtUsd } from '../lib/money.js';
import { createCryptoInvoice, isApironeConfigured } from '../lib/apirone.js';
import { startOfISTDay } from '../lib/ist.js';
import { notify } from '../lib/notifier.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();

// GET /api/support — our OWN support channels (admin-configured, empty until
// filled in). Clients only ever see InstaSMM's contacts — never a supplier's
// (Task 9).
r.get('/support', requireAuth, (req, res) => {
  const g = (k) => String(getSetting(k) || '').trim();
  return res.json({
    channels: {
      email: g('support_email'),
      whatsapp: g('support_whatsapp'),
      telegram: g('support_telegram'),
      phone: g('support_phone'),
    },
  });
});

// GET /api/wallet — balance in INR; total spent in both USD & INR; today's
// spend (real ledger aggregates, IST bucket — never a fabricated number).
r.get('/wallet', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT wallet_balance, total_spent_inr FROM users WHERE id=?').get(req.user.id);
  const rate = getExchangeRate();
  const totalInr = user.total_spent_inr;
  const todayStart = startOfISTDay(Date.now());
  const today = db.prepare(
    `SELECT COALESCE(SUM(amount_inr),0) AS spent FROM transactions
     WHERE user_id=? AND type='order' AND created_at >= ?`
  ).get(req.user.id, todayStart).spent;
  // Real DB counts for the dashboard (never a sliced array length).
  const stats = db.prepare(
    `SELECT (SELECT COUNT(*) FROM orders WHERE user_id=?) AS orders_total,
            (SELECT COUNT(*) FROM deposits WHERE user_id=?) AS deposits_total,
            (SELECT COUNT(*) FROM deposits WHERE user_id=? AND status='pending') AS deposits_pending,
            (SELECT COUNT(*) FROM orders WHERE user_id=? AND status IN ('COMPLETED','PARTIAL')) AS orders_completed`
  ).get(req.user.id, req.user.id, req.user.id, req.user.id);
  return res.json({
    balance_inr: user.wallet_balance,
    total_spent_inr: totalInr,
    total_spent_usd: (totalInr / 100 / rate).toFixed(2), // precise float for display
    total_spent_usd_cents: inrToUsd(totalInr, rate),
    today_spent_inr: today,
    exchange_rate: rate,
    currency: 'INR',
    stats,
  });
});

// GET /api/wallet/transactions — ledger history.
r.get('/wallet/transactions', requireAuth, (req, res) => {
  const tx = getDb().prepare(
    `SELECT id, type, amount_inr, balance_after, ref_id, meta_json, created_at
     FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100`
  ).all(req.user.id);
  return res.json({ transactions: tx });
});

// GET /api/cryptos — supported deposit cryptos (with LTC hot flag). The
// `simulated` flag is only ever true in SMM_TEST mode — a production client is
// never told to trust a fake/test payment path (Task 18).
r.get('/cryptos', (req, res) => {
  const testMode = process.env.SMM_TEST === '1';
  return res.json({
    cryptos: config.depositCryptos.map((c) => ({ id: c.id, label: c.label, short: c.short, hot: c.hot })),
    simulated: testMode ? !isApironeConfigured() : false,
  });
});

// POST /api/deposits — create a crypto deposit invoice (USD amount).
r.post('/deposits', requireAuth, ah(async (req, res) => {
  let amountUsd = Number(req.body?.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return sendErr(res, 400, 'Enter a valid deposit amount in USD.');
  }
  const currency = String(req.body?.currency || 'LTC');
  if (!config.depositCryptos.some((c) => c.id === currency)) {
    return sendErr(res, 400, 'Unsupported currency.');
  }
  const rate = getExchangeRate();
  const usdCents = Math.round(amountUsd * 100);
  const inrPaise = usdToInr(usdCents, rate);
  const now = Date.now();
  const timeoutHours = Number(getDb().prepare(`SELECT value FROM settings WHERE key='deposit_timeout_hours'`).get().value || 24);

  let invoice;
  try {
    invoice = await createCryptoInvoice({ currency, amountUsd: usdCents });
  } catch (e) {
    return sendErr(res, 502, `Payment gateway error: ${e.message}`);
  }

  const info = getDb().prepare(
    `INSERT INTO deposits (user_id, invoice_id, currency, currency_code, amount_usd, amount_minor, amount_inr, address, status, is_simulated, created_at, expires_at)
     VALUES (?,?,?,?,?,?,0,?,'pending',?,?,?)`
  ).run(
    req.user.id, invoice.invoiceId, currency, invoice.currencyCode, usdCents,
    invoice.amountMinor, invoice.address,
    invoice.simulated ? 1 : 0, now, now + timeoutHours * 3600 * 1000
  );

  // Creating an invoice is NOT receiving payment: notify "Deposit Created",
  // never "Deposit Confirmed". Confirmation only happens in creditDeposit()
  // after a real (or explicitly simulated) payment event.
  try {
    notify(req.user.id, 'deposit', 'Deposit Created',
      `${fmtUsd(usdCents / 100)} invoice in ${currency} — waiting for payment. Notify you when it is confirmed.`);
  } catch { /* never block on a notification */ }

  return res.status(201).json({
    deposit: {
      id: Number(info.lastInsertRowid),
      invoice_id: invoice.invoiceId,
      currency,
      currency_code: invoice.currencyCode,
      amount_usd: usdCents,
      amount_minor: invoice.amountMinor,
      amount_inr: inrPaise, // what the wallet will be credited
      address: invoice.address,
      status: 'pending',
      simulated: invoice.simulated,
      expires_at: now + timeoutHours * 3600 * 1000,
    },
  });
}));

// GET /api/deposits — history. Includes the live invoice fields (address,
// amount_minor, verified receipt) so a pending invoice can be REOPENED on the
// same address/QR/amount without creating a new invoice (Task 2).
r.get('/deposits', requireAuth, (req, res) => {
  const dep = getDb().prepare(
    `SELECT id, invoice_id, currency, currency_code, amount_usd, amount_inr, amount_minor,
            address, status, is_simulated, paid_usd, received_minor, tx_hash,
            created_at, expires_at, paid_at, confirmed_at
     FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
  ).all(req.user.id);
  return res.json({ deposits: dep, exchange_rate: getExchangeRate() });
});

// GET /api/deposits/:id — full invoice detail for the reopen flow (own row OR
// anything visible in the history above — same 50-row window, ownership check).
r.get('/deposits/:id', requireAuth, (req, res) => {
  const d = getDb().prepare(
    `SELECT id, invoice_id, currency, currency_code, amount_usd, amount_inr, amount_minor,
            address, status, is_simulated, paid_usd, received_minor, tx_hash,
            created_at, expires_at, paid_at, confirmed_at, reject_reason
     FROM deposits
     WHERE id=? AND user_id=?
       AND id IN (SELECT id FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 50)`
  ).get(req.params.id, req.user.id, req.user.id);
  if (!d) return sendErr(res, 404, 'Deposit not found.');
  return res.json({ deposit: d, exchange_rate: getExchangeRate() });
});

export default r;