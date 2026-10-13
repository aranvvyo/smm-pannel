import { Router } from 'express';
import { getDb, getExchangeRate } from '../db.js';
import { requireAdmin, logSecurity } from '../middleware/auth.js';
import {
  isApironeConfigured, apironeCreds, apironeAuthFetch,
  estimateWithdrawal, submitWithdrawal, apironeWalletBalance,
  cryptoCurrencyCode, cryptoDecimals, coinToMinor,
  cryptoMinorToUsdCents, redactApironeKey, CURRENCY_MAP,
} from '../lib/apirone.js';
import { ah, sendErr } from './_helpers.js';
import { executeWithdrawal } from '../lib/withdrawalExecution.js';

const r = Router();
r.use(requireAdmin); // Admin/Owner-only — clients get 403 on the whole surface.

// Network label for the UI (derived from the currency, never client-supplied).
const NET_LABEL = { LTC: 'Litecoin', TRC20_USDT: 'TRC20', BEP20_USDT: 'BEP20', ERC20_USDT: 'ERC20' };

// Strict, network-specific address validation (Task 8). Per-pattern:
//   LTC    → bech32 (`ltc1…`) or legacy base58 (`L…`/`M…`)
//   TRC20  → Tron base58 (`T` + 33)
//   BEP20/ERC20 → EVM (`0x` + 40 hex) — a TRC20 address never matches, and vice
//   versa, so the wrong network can never be selected accidentally.
function normalizeWithdrawalAddress(currency, raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (currency === 'LTC') {
    const addr = s.replace(/^(litecoin:|LTC:)/i, '');
    if (/^ltc1[0-9a-z]{20,}$/.test(addr)) return addr;
    if (/^[LM3][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr)) return addr;
    return null;
  }
  if (currency === 'TRC20_USDT') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) ? s : null;
  if (currency === 'BEP20_USDT' || currency === 'ERC20_USDT') {
    return /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null;
  }
  return null;
}

// The withdrawal flow NEVER reads an address from the request body — it only
// ever uses the admin's saved address for that exact currency/network.
function savedAddress(db, currency) {
  return db.prepare('SELECT currency, address, network FROM withdraw_addresses WHERE currency=?').get(currency) || null;
}

const maskAddr = (a) => {
  a = String(a || '');
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
};

// GET /api/admin/withdrawals — audit history + saved addresses (admin-only).
// Gateway error text is run through redaction so the transfer key can never
// persist in a log row.
r.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT w.id, w.currency, w.currency_code, w.address, w.mode,
            w.amount_minor, w.amount_usd, w.fee, w.subtract_fee,
            w.transfer_ref, w.tx_hash, w.status, w.error, w.created_at, w.executed_at,
            u.email AS admin_email
     FROM withdrawals w JOIN users u ON u.id = w.admin_id
     ORDER BY w.created_at DESC LIMIT 100`
  ).all();
  const networkOf = (c) => NET_LABEL[c] || c;
  for (const row of rows) {
    if (row.error) row.error = String(redactApironeKey(row.error)).slice(0, 240);
    row.network = networkOf(row.currency);
    row.address_masked = maskAddr(row.address);
  }
  const addresses = db.prepare('SELECT currency, address, network, updated_at FROM withdraw_addresses').all();
  const rate = getExchangeRate();
  return res.json({
    withdrawals: rows,
    addresses,
    exchange_rate: rate,
    configured: isApironeConfigured(),
    networks: Object.entries(NET_LABEL).map(([id, net]) => ({ id, code: cryptoCurrencyCode(id), net })),
  });
});

// GET /api/admin/withdrawals/balances — REAL live balances for every supported
// currency/network (one authenticated call each, currency query passed per the
// docs). A failed/absent read is reported as `null` (never a fabricated number).
r.get('/balances', ah(async (req, res) => {
  if (!isApironeConfigured()) return sendErr(res, 400, 'Apirone credentials are not configured.');
  const balances = {};
  const failures = [];
  await Promise.all(Object.keys(CURRENCY_MAP).map(async (c) => {
    try {
      balances[c] = await apironeWalletBalance(c);
      if (balances[c] == null) failures.push(c);
    } catch { failures.push(c); }
  }));
  return res.json({ balances, failures, configured: true, networks: NET_LABEL });
}));

// GET /api/admin/withdrawals/balance?currency= — single-currency live balance
// (kept for compatibility; the UI uses /balances).
r.get('/balance', ah(async (req, res) => {
  if (!isApironeConfigured()) return sendErr(res, 400, 'Apirone credentials are not configured.');
  const currency = String(req.query.currency || 'LTC').toUpperCase();
  if (!cryptoCurrencyCode(currency)) return sendErr(res, 400, 'Unsupported currency.');
  const { status, ok, data } = await apironeAuthFetch(
    `/accounts/${encodeURIComponent(apironeCreds().account_id)}/balance`,
    { query: { currency: cryptoCurrencyCode(currency) } }
  );
  if (!ok) return sendErr(res, 502, `Balance query failed (gateway ${status}).`);
  return res.json({ currency, available: null, data: (() => {
    try { return JSON.parse(redactApironeKey(JSON.stringify(data))); } catch { return data; }
  })() });
}));

// ---- Saved addresses (Task 1 / Task 8) ----
// GET /api/admin/withdrawals/addresses — the saved withdrawal addresses.
r.get('/addresses', (req, res) => {
  const rows = getDb().prepare('SELECT currency, address, network, created_at, updated_at FROM withdraw_addresses').all();
  return res.json({ addresses: rows });
});

// PUT /api/admin/withdrawals/addresses/:currency — save or replace an address.
// Validation is per-network server-side; replacing an existing address requires
// an explicit confirmation flag (Task 8).
r.put('/addresses/:currency', (req, res) => {
  const currency = String(req.params.currency || '').trim().toUpperCase();
  const meta = CURRENCY_MAP[currency];
  if (!meta) return sendErr(res, 400, 'Unsupported currency/network.');
  const raw = String(req.body?.address || '').trim();
  const address = normalizeWithdrawalAddress(currency, raw);
  if (!address) {
    return sendErr(res, 400, `That does not look like a valid ${meta.net} address for ${currency}.`);
  }
  const db = getDb();
  const existing = db.prepare('SELECT address FROM withdraw_addresses WHERE currency=?').get(currency);
  const now = Date.now();
  if (existing) {
    if (existing.address === address) {
      // Same address re-saved — no-op success, nothing replaced.
      return res.json({ ok: true, address: { currency, address, network: meta.net } });
    }
    if (req.body.confirm_replace !== true && req.body.confirm !== true) {
      return sendErr(res, 409, 'An address already exists for this network — confirm to replace it.', 'ADDRESS_REPLACE_CONFIRM');
    }
    db.prepare('UPDATE withdraw_addresses SET address=?, network=?, updated_at=? WHERE currency=?')
      .run(address, meta.net, now, currency);
  } else {
    db.prepare('INSERT INTO withdraw_addresses (currency, address, network, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(currency, address, meta.net, now, now);
  }
  logSecurity(req.user.id, req.user.email, `withdraw_address_save_${currency}`, req.ip);
  return res.json({ ok: true, address: { currency, address, network: meta.net } });
});

// POST /api/admin/withdrawals/estimate — fee estimation (GET on the transfer
// path, per the docs) for the SAVED destination. NEVER executes anything.
r.post('/estimate', ah(async (req, res) => {
  if (!isApironeConfigured()) return sendErr(res, 400, 'Apirone credentials are not configured.');
  const db = getDb();
  const currency = String(req.body?.currency || '').trim().toUpperCase();
  if (!CURRENCY_MAP[currency]) return sendErr(res, 400, 'Unsupported currency.');
  const saved = savedAddress(db, currency);
  if (!saved) return sendErr(res, 400, 'Save a withdrawal address for this currency first.', 'ADDRESS_REQUIRED');

  const args = withdrawalArgs(req.body, saved.address);
  if (args.error) return sendErr(res, 400, args.error);
  const out = await estimateWithdrawal(args.payload);
  let e = null;
  try { e = JSON.parse(redactApironeKey(JSON.stringify(out.data ?? null))); } catch { e = null; }
  const network = Number(e?.fee?.network?.amount ?? 0) || 0;
  const processing = Number(e?.fee?.processing?.amount ?? 0) || 0;
  const amount = Number(e?.amount ?? 0) || 0;
  return res.json({
    ok: out.ok,
    status: out.status,
    estimate: e,
    request: {
      currency,
      network: NET_LABEL[currency] || currency,
      address_masked: maskAddr(saved.address),
      mode: args.payload.mode,
      fee: args.payload.fee,
      subtract_fee: args.payload['subtract-fee-from-amount'],
    },
    fees: { network, processing },
    net_estimate: Math.max(0, amount - network - processing),
  });
}));

// POST /api/admin/withdrawals — EXECUTE a transfer (amount) or full sweep to the
// SAVED address. The address is never taken from the request body (Task 1/8).
//
// Guards (Task 6):
//   - Admin/Owner-only (router-level requireAdmin).
//   - requires an explicit confirmation flag (`confirmed === true`);
//   - duplicate submissions are impossible (idempotency key = a client-supplied
//     key OR the exact same transfer parameters — the DB enforces uniqueness);
//   - a recency check rejects any identical transfer within 2 minutes;
//   - the gateway's transfer reference AND real on-chain tx hash (when returned)
//     are stored — never fabricated;
//   - no API response ever contains the transfer key.
r.post('/', ah(async (req, res) => {
  if (!isApironeConfigured()) return sendErr(res, 400, 'Apirone credentials are not configured. Withdrawals cannot be faked.');
  const body = req.body || {};
  if (body.confirmed !== true) {
    return sendErr(res, 400, 'Confirm this withdrawal to proceed.', 'CONFIRM_REQUIRED');
  }

  const db = getDb();
  const currency = String(body.currency || 'LTC').toUpperCase();
  if (!CURRENCY_MAP[currency]) return sendErr(res, 400, 'Unsupported currency.');
  const saved = savedAddress(db, currency);
  if (!saved) return sendErr(res, 400, 'Save a withdrawal address for this currency first.', 'ADDRESS_REQUIRED');

  const args = withdrawalArgs(body, saved.address);
  if (args.error) return sendErr(res, 400, args.error);
  const { payload, address, mode, amountMinor } = args;

  const rate = getExchangeRate();
  const suppliedKey = String(body.idempotency_key || '').trim();
  if (suppliedKey.length > 64) return sendErr(res, 400, 'Invalid idempotency key.');
  // The UI supplies one key per transfer intent. Scripted callers get a key
  // derived from the exact parameters, so an identical resend is still blocked.
  const key = suppliedKey || `w:${mode}:${currency}:${address}:${amountMinor}`;

  // Informational USD value (best-effort ticker). Sweep stays 0 ("unknown").
  const amountUsd = mode === 'amount'
    ? (await cryptoMinorToUsdCents(currency, amountMinor) ?? 0)
    : 0;

  const out = await executeWithdrawal({
    db,
    key,
    submit: () => submitWithdrawal(payload),
    redact: redactApironeKey,
    row: {
      adminId: req.user.id, currency, currencyCode: cryptoCurrencyCode(currency), address, mode,
      amountMinor, amountUsd, rate, fee: payload.fee, subtractFee: payload.subtractFee,
    },
  });
  if (!out.ok) {
    logSecurity(req.user.id, req.user.email, `withdraw_${out.code.toLowerCase()}`, req.ip);
    return sendErr(res, out.http, out.message, out.code);
  }
  logSecurity(req.user.id, req.user.email, `withdraw_${mode}`, req.ip);
  return res.status(201).json({
    ok: true,
    withdrawal: {
      mode, currency, address,
      amount_minor: amountMinor,
      amount_usd: amountUsd,
      transfer_ref: out.result.ref,
      tx_hash: out.result.txHash,
      status: 'sent',
    },
  });
}));

// Shared argument parsing + validation for amount and sweep modes. `address` is
// the SAVED destination (resolved by the caller — never from the request body).
function withdrawalArgs(body, address) {
  const currency = String(body.currency || 'LTC').toUpperCase();
  const code = cryptoCurrencyCode(currency);
  if (!code) return { error: 'Unsupported currency.' };

  const mode = body.mode === 'sweep' ? 'sweep' : 'amount';
  const fee = ['normal', 'priority', 'custom'].includes(body.fee) ? body.fee : 'normal';
  const subtractFee = body.subtract_fee !== false && body.subtract_fee !== 'false';

  let amountMinor = 0;
  if (mode === 'amount') {
    const minor = coinToMinor(body.amount_coin, cryptoDecimals(currency));
    if (!minor || minor <= 0) return { error: 'Enter an amount greater than zero for this currency.' };
    amountMinor = minor;
  }
  const payload = { currency, address, amountMinor, mode, fee, subtractFee };
  return { payload, currency, address, mode, amountMinor };
}

export default r;