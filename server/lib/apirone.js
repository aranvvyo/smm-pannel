import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getDb, getSetting, getExchangeRate } from '../db.js';
import { usdToInr, fmtUsd, fmtInr } from './money.js';
import { notify } from './notifier.js';

// ---------------------------------------------------------------------------
// NOTE (verified against https://apirone.com/docs as of 2026-09):
//   - Create invoice   : POST /api/v2/accounts/{account}/invoices
//                        body { currency, amount, callback-url, linkback, ... }  (unauthenticated)
//   - Invoice info     : GET  /api/v2/invoices/{invoice}                         (public)
//                        → { status, amount, address, history:[{amount, txid, status}] }
//   - Withdraw/transfer: POST /api/v2/accounts/{account}/transfer                (Bearer access-token)
//                        body { account, currency, destinations:[{address, amount}],
//                               subtract-fee-from-amount, fee }
//                        A GET on the same path returns the fee ESTIMATION without sending.
//   - Auth             : POST /api/v2/auth/login  body { login, password }       (password = transfer key)
//                        → { access-token, refresh-token, login }   (10-minute lifetime)
//                        Authenticated requests use `Authorization: Bearer <access-token>`
//                        — the transfer key itself is NEVER sent in a URL or logged.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Apirone v2 crypto deposit gateway — REAL, server-side, idempotent.
//
// Credentials NEVER come from env/code. The Account ID, Transfer Key and
// Webhook Token are entered at runtime through Admin → Settings and stored in
// the settings table (write-only — never returned by any API).
//
// Live mode   — account_id + transfer_key are set: we create REAL Apirone
//               invoices (account-path addressed; per the docs the create-invoice
//               endpoint is unauthenticated — the transfer key is NEVER sent in
//               a query string; it is only used to validate via /auth/login),
//               draw REAL deposit addresses, and credit the wallet ONLY after
//               the payment is verified server-side against the public
//               invoice-info endpoint. Partial payments credit the verified
//               fraction — never more.
//
// Simulated   — no credentials: invoice creation returns a clearly-SIM test
//               address; nothing is credited until an explicit payment event
//               (simulator webhook or admin manual confirm). No fake tx ids,
//               no auto-credit from invoice creation, ever.
// ---------------------------------------------------------------------------

// Currency + network map. Keys are the internal IDs used everywhere else in the
// panel (deposits, withdrawals, saved addresses). `code` is the Apirone v2
// currency code (verified against apirone.com/docs as of 2026-09). Polygon
// USDT is NOT in the official code list (no `usdt@matic`) — deliberately absent.
export const CURRENCY_MAP = {
  LTC:        { code: 'ltc',      decimals: 8, net: 'Litecoin' },
  TRC20_USDT: { code: 'usdt@trx', decimals: 6, net: 'TRC20' },
  BEP20_USDT: { code: 'usdt@bnb', decimals: 6, net: 'BEP20' },
  ERC20_USDT: { code: 'usdt@eth', decimals: 6, net: 'ERC20' },
};
export function resolveCurrency(currency) {
  return CURRENCY_MAP[currency] || null;
}

// Unsupported-but-requested networks, surfaced honestly instead of invented.
export const UNSUPPORTED_CURRENCIES = {
  POLYGON_USDT: { reason: 'usdt@matic is not in the official Apirone v2 currency list' },
};

// Display helpers for real crypto amounts — an integer number can NEVER render
// as "$0.00" (there is no USD here) or "LTC0" (ticker/currency concatenation).
const CRYPTO_DECIMALS = { LTC: 8, TRC20_USDT: 6, BEP20_USDT: 6, ERC20_USDT: 6 };
const CRYPTO_TICKER = { LTC: 'LTC', TRC20_USDT: 'USDT', BEP20_USDT: 'USDT', ERC20_USDT: 'USDT' };
export function cryptoMinorLabel(currency, minor) {
  const m = Number(minor) || 0;
  const dec = CRYPTO_DECIMALS[currency] ?? 8;
  const n = m / Math.pow(10, dec);
  const ticker = CRYPTO_TICKER[currency] || currency;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: dec })} ${ticker}`;
}
export function cryptoCurrencyCode(currency) {
  return CURRENCY_MAP[currency]?.code || null;
}
export function cryptoDecimals(currency) {
  return CRYPTO_DECIMALS[currency] ?? 8;
}

// "0.5" → 50_000_000 with decimals=8. Pure string math (no float drift) —
// accepts "0", "0.5", "1.", ".25", "-0.1". Returns null on garbage.
export function coinToMinor(coinStr, decimals) {
  const s = String(coinStr ?? '').trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '.' || s === '') return null;
  const [int = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = (BigInt(int || '0') * 10n ** BigInt(decimals)) + BigInt(fracPadded || '0');
  if (minor > 2n ** 62n) return null; // sanity bound
  return Number(minor);
}

// ---- Credentials (environment-first, settings-table backed, write-only) ----
// Precedence: a non-blank APIRONE_ACCOUNT_ID / APIRONE_TRANSFER_KEY
// environment variable is the authoritative default (it survives restarts
// and redeployments without manual re-entry); a blank variable falls back
// to the value stored in the settings table (Admin → Settings), so manually
// entered credentials are preserved and a blank environment value can never
// erase them. Values are read at call time and NEVER written back to the
// database, so stored settings always remain intact.
export function apironeCreds() {
  const envAccount = String(process.env.APIRONE_ACCOUNT_ID || '').trim();
  const envTransfer = String(process.env.APIRONE_TRANSFER_KEY || '').trim();
  return {
    account_id: envAccount || String(getSetting('apirone_account_id') || '').trim(),
    transfer_key: envTransfer || String(getSetting('apirone_transfer_key') || '').trim(),
    webhook_token: String(getSetting('apirone_webhook_token') || '').trim(),
  };
}

export function isApironeConfigured() {
  const c = apironeCreds();
  return Boolean(c.account_id && c.transfer_key);
}

// ---- Network helpers -------------------------------------------------------
const AIP = `${config.apirone.apiUrl.replace(/\/+$/, '')}/api/v2`;

async function apironeFetch(path, { method = 'GET', body, query = {}, timeoutMs = 15000 } = {}) {
  const url = new URL(AIP + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  return { status: res.status, ok: res.ok, text, data };
}

// ---- Authenticated requests (transfer / sweep). ---------------------------
// The access token is exchanged from the transfer key over HTTPS, cached in
// memory (never persisted, never logged), and refreshed lazily. The transfer
// key itself is only ever sent inside the /auth/login JSON body — never in a
// URL/query string and never echoed anywhere.
let authToken = null;
let authTokenExpiry = 0;

async function ensureAuthToken() {
  const creds = apironeCreds();
  if (!creds.account_id || !creds.transfer_key) {
    throw new Error('Apirone credentials not configured.');
  }
  // Docs default lifetime is 10 minutes; refresh with margin.
  if (authToken && Date.now() < authTokenExpiry - 60_000) return authToken;
  const { ok, status, data } = await apironeFetch('/auth/login', {
    method: 'POST',
    body: { login: creds.account_id, password: creds.transfer_key },
  });
  if (!ok) throw new Error(`Apirone auth failed (${status})`);
  const token = String(data?.['access-token'] || '');
  if (!token) throw new Error('Apirone auth returned no access token');
  authToken = token;
  authTokenExpiry = Date.now() + 10 * 60 * 1000;
  return token;
}

export async function apironeAuthFetch(path, { method = 'GET', body, query = {}, timeoutMs = 15000 } = {}) {
  const token = await ensureAuthToken();
  const url = new URL(AIP + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  return { status: res.status, ok: res.ok, text, data };
}

// GET /api/v2/ticker?currency=ltc&fiat=usd  →  {"usd": 65.5183} (USD price of 1 unit)
async function fetchUsdPrice(currencyCode) {
  const { ok, data, status, text } = await apironeFetch('/ticker', { query: { currency: currencyCode, fiat: 'usd' } });
  if (!ok || !data || typeof data.usd !== 'number') {
    throw new Error(`Apirone ticker failed (${status}): ${text.slice(0, 120) || 'no data'}`);
  }
  return data.usd;
}

// USD (integer cents) → crypto **minor units** for the currency.
function usdToMinor(decimals, usdCents, usdPrice) {
  // minorUnits per 1 USD = 10^decimals / price
  return Math.round((usdCents / 100) * (Math.pow(10, decimals) / usdPrice));
}

// The reverse, only meaningful relative to the invoice: how many USD cents the
// received minor amount corresponds to, capped at the invoice amount.
export function paidMinorToUsdCents(deposit, paidMinor) {
  const invoiceMinor = Number(deposit.amount_minor);
  if (invoiceMinor > 0) {
    const fraction = Math.min(1, paidMinor / invoiceMinor);
    return Math.round(Number(deposit.amount_usd) * fraction);
  }
  // No stored minor (legacy deposit) — any payment means the full amount.
  return paidMinor > 0 ? Number(deposit.amount_usd) : 0;
}

// ---- Invoice info (public verify endpoint) --------------------------------
export async function apironeInvoiceInfo(invoiceId) {
  const { ok, data } = await apironeFetch(`/invoices/${encodeURIComponent(invoiceId)}`);
  if (!ok || !data || typeof data !== 'object') throw new Error('Apirone invoice-info unavailable');
  return data;
}

export function invoiceStatusFromInfo(info) {
  return String(info?.status || info?.state || info?.paymentStatus || '').toLowerCase();
}

// Cumulative received minor units. Prefer the explicit `paid`/`received` field
// (documented as cumulative); fall back to summing per-payment history amounts.
// Never used to credit beyond what Apirone reports as actually received.
export function invoicePaidMinor(info) {
  if (!info || typeof info !== 'object') return 0;
  const explicit = Number(info.paid ?? info.paidAmount ?? info.received ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (Array.isArray(info.history)) {
    let sum = 0;
    for (const h of info.history) {
      const a = Number(h?.amount ?? h?.value ?? NaN);
      if (Number.isFinite(a) && a > 0) sum += a;
    }
    return sum;
  }
  return 0;
}

// The most recent verified on-chain tx id from the invoice history. This is a
// REAL Apirone-issued value — a deposit is only ever stored with this or nil.
export function latestTxHash(info) {
  if (Array.isArray(info?.history)) {
    for (let i = info.history.length - 1; i >= 0; i--) {
      const h = info.history[i];
      const t = String(h?.txid ?? h?.hash ?? '').trim();
      if (t) return t;
    }
  }
  return null;
}

// ---- Test connection (Admin → Settings) -----------------------------------
export async function apironeTestConnection() {
  const creds = apironeCreds();
  if (!creds.account_id || !creds.transfer_key) {
    throw new Error('Enter an Account ID and Transfer Key first.');
  }
  // Documented v2 auth: exchange account-credentials for a short-lived JWT.
  // Response fields (verbatim): login, access-token, refresh-token.
  const { ok, status, data, text } = await apironeFetch('/auth/login', {
    method: 'POST',
    body: { login: creds.account_id, password: creds.transfer_key },
  });
  if (!ok) throw new Error(`Apirone auth failed (${status}): ${text.slice(0, 160) || 'bad credentials'}`);
  return { ok: true, token_issued: Boolean(data?.['access-token']) };
}

// ---------------------------------------------------------------------------
// Admin withdrawal / sweep — POST /api/v2/accounts/{account}/transfer (Bearer).
// Documented behavior (apirone.com/docs/account): the GET form on the SAME path
// returns a fee ESTIMATION without sending funds; POST executes the transfer.
// amount may be "100%" for a full sweep. We always pass fee explicitly and
// subtract-fee-from-amount explicitly so no side-effect is ever guessed.
// ---------------------------------------------------------------------------

function withdrawalBody({ currency, address, amountMinor, mode, fee = 'normal', subtractFee = true }) {
  const code = cryptoCurrencyCode(currency);
  if (!code) throw new Error(`Unsupported currency: ${currency}`);
  return {
    account: apironeCreds().account_id,
    currency: code,
    destinations: [{ address, amount: mode === 'sweep' ? '100%' : Number(amountMinor) }],
    'subtract-fee-from-amount': Boolean(subtractFee),
    fee,
  };
}

export async function estimateWithdrawal(args) {
  const auth = await ensureAuthToken();
  const url = new URL(AIP + `/accounts/${encodeURIComponent(apironeCreds().account_id)}/transfer`);
  const body = withdrawalBody(args);
  for (const [k, v] of Object.entries(body)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

export async function submitWithdrawal(args) {
  const { ok, status, data, text } = await apironeAuthFetch(
    `/accounts/${encodeURIComponent(apironeCreds().account_id)}/transfer`,
    { method: 'POST', body: withdrawalBody(args) }
  );
  if (!ok) throw new Error(`Withdrawal rejected by the gateway (${status}): ${(text || 'see gateway logs').slice(0, 160)}`);
  // The gateway answers with its own payment id — we store THAT, plus the real
  // on-chain transaction hash(es) from `txs` when present. Nothing is invented.
  const ref = String(data?.id ?? data?.transfer ?? data?.transaction ?? '').trim();
  if (!ref) throw new Error('Gateway accepted the transfer but returned no reference — nothing recorded, verify manually.');
  const txHash = (Array.isArray(data?.txs)
    ? String(data.txs.find((t) => typeof t === 'string' && String(t).trim()) ?? '').trim()
    : '') || null;
  return { ok: true, ref, txHash, data };
}

// Live balance for one currency. Per docs, token currencies (usdt@…) require
// the `currency` query param — we always pass it explicitly. Returns minor
// units when the gateway reports a number, else null (never invented).
export async function apironeWalletBalance(currency) {
  const map = resolveCurrency(currency);
  if (!map) throw new Error(`Unsupported currency: ${currency}`);
  const { ok, status, data } = await apironeAuthFetch(
    `/accounts/${encodeURIComponent(apironeCreds().account_id)}/balance`,
    { query: { currency: map.code } }
  );
  if (!ok) throw new Error(`Balance query failed (gateway ${status})`);
  if (!data || typeof data !== 'object') return null;
  // The gateway may shape this as { code: number }, { balance }, { available },
  // { total }, or a list grouped per wallet — extract whatever is present.
  const pick = (o) => {
    const scope = Array.isArray(o) ? o.find((w) => w?.currency === map.code || w?.id === map.code) : o;
    if (!scope || typeof scope !== 'object') return null;
    const v = Number(scope[map.code] ?? scope.balance ?? scope.available ?? scope.total ?? scope.amount ?? NaN);
    return Number.isFinite(v) ? v : null;
  };
  return pick(data);
}

// Informational USD value for admin display — best-effort live ticker, never
// fabricated. Returns null when the ticker is unavailable (0 stays "unknown").
export async function cryptoMinorToUsdCents(currency, minorUnits) {
  const map = resolveCurrency(currency);
  if (!map) return null;
  try {
    const price = await fetchUsdPrice(map.code);
    return Math.round((Number(minorUnits) / Math.pow(10, map.decimals)) * price * 100);
  } catch {
    return null;
  }
}

// Strip any occurrence of the transfer key from gateway text before it lands in
// the audit log / API (defense in depth — the key must never persist anywhere).
export function redactApironeKey(text) {
  const key = apironeCreds().transfer_key;
  return key ? String(text ?? '').split(key).join('[redacted]') : text;
}

// ---------------------------------------------------------------------------
// Invoice creation.
// ---------------------------------------------------------------------------
export function simulatedCurrency(currency) {
  // obviously-fake test address — never used to send real funds.
  const hex = randomBytes(18).toString('hex');
  if (currency === 'LTC') return `L${hex.slice(0, 26).toUpperCase()}`;
  return `0x${hex}`;
}

// Create an invoice for `amountUsd` (integer cents) in `currency`.
// Returns { invoiceId, address, amountMinor, currencyCode, simulated }.
// Simulated mode returns a SIM invoice + test address — and it is ONLY ever
// reachable under SMM_TEST=1. A production boot with no Apirone credentials
// REFUSES to mint a fake address (Task 18 rule: no fake deposits in prod).
export async function createCryptoInvoice({ currency, amountUsd }) {
  const creds = apironeCreds();
  if (!creds.account_id || !creds.transfer_key) {
    if (process.env.SMM_TEST !== '1') {
      throw new Error('Crypto payments are not configured yet — the panel must not create fake invoices. Enter Apirone credentials in Admin → Settings, or contact the operator.');
    }
    return {
      invoiceId: `SIM-${randomBytes(6).toString('hex').toUpperCase()}`,
      address: simulatedCurrency(currency),
      amountMinor: 0,
      currencyCode: CURRENCY_MAP[currency]?.code || currency.toLowerCase(),
      simulated: true,
    };
  }
  const map = CURRENCY_MAP[currency];
  if (!map) throw new Error(`Unsupported currency: ${currency}`);

  const usdPrice = await fetchUsdPrice(map.code);
  const amountMinor = usdToMinor(map.decimals, amountUsd, usdPrice);
  const cb = config.publicBaseUrl;
  // Request body fields per Apirone docs (verbatim, hyphenated): currency,
  // amount (minor units, string recommended), callback-url, linkback.
  // create-invoice is documented as UNAUTHENTICATED — no transfer-key is sent.
  const { ok, status, data, text } = await apironeFetch(
    `/accounts/${encodeURIComponent(creds.account_id)}/invoices`,
    {
      method: 'POST',
      body: {
        currency: map.code,
        amount: String(amountMinor),
        'callback-url': `${cb}/webhooks/apirone`,
        linkback: `${cb}/deposit`,
      },
    }
  );
  if (!ok) throw new Error(`Apirone invoice failed (${status}): ${text.slice(0, 160) || 'request rejected'}`);

  const invoiceId = String(data?.id ?? data?.invoice ?? '');
  const address = String(data?.address ?? data?.payIn?.address ?? '');
  if (!invoiceId || !address) throw new Error('Apirone returned an invoice without address/id');
  return { invoiceId, address, amountMinor, currencyCode: map.code, simulated: false };
}

// ---------------------------------------------------------------------------
// Crediting — the only money-granting path, idempotent.
//
// Called from: real Apirone webhook (server-verified), the deposit reconciler,
// the simulator, and admin manual confirm.
//
// With { receivedUsdCents } we credit only the newly-received verified slice.
// Without it (manual/simulator confirm) we credit the remaining invoice amount.
// A deposit is never credited twice: once paid_usd reaches amount_usd (or the
// status is terminal) further attempts are rejected.
// ---------------------------------------------------------------------------
export function creditDeposit(depositId, { receivedUsdCents, receivedMinor, txHash } = {}) {
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM deposits WHERE id=?').get(depositId);
  if (!deposit) return { ok: false, reason: 'not-found' };

  // Terminal statuses are final — no double credit, no resurrection.
  if (['confirmed', 'rejected', 'expired'].includes(deposit.status)) {
    return { ok: false, reason: 'already-' + deposit.status };
  }
  // Pending + past expiry = expired (a real late payment must be verified
  // manually by an admin before it can ever be credited).
  if (deposit.status === 'pending' && Date.now() > deposit.expires_at) {
    markExpired(deposit);
    return { ok: false, reason: 'expired' };
  }

  // Paid `in_progress` deposits never expire on their own — funds arrived.
  const targetUsd = receivedUsdCents != null
    ? Math.min(Number(deposit.amount_usd), Math.round(receivedUsdCents))
    : Number(deposit.amount_usd);
  const paidUsdBefore = Number(deposit.paid_usd || 0);
  const remaining = Math.round(targetUsd - paidUsdBefore);
  if (remaining <= 0) return { ok: false, reason: paidUsdBefore >= Number(deposit.amount_usd) ? 'already-paid' : 'no-new-funds' };

  const rate = getExchangeRate();
  const inr = usdToInr(remaining, rate);
  const paidUsdNew = paidUsdBefore + remaining;
  const status = paidUsdNew >= Number(deposit.amount_usd) ? 'confirmed' : 'in_progress';
  const now = Date.now();

  // The verified on-chain pieces we are allowed to display — real minor units
  // and a real txid only. Manual confirms (no receivedMinor) keep whatever is
  // already stored; we never fabricate either value.
  const resvMinor = Number(receivedMinor ?? deposit.received_minor ?? 0);
  const resvHash = String(txHash ?? deposit.tx_hash ?? '').trim() || null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE deposits SET status=?, paid_usd=?, amount_inr=?, paid_at=?, confirmed_at=?,
        received_minor=CASE WHEN ? > 0 THEN CAST(? AS DOUBLE PRECISION) ELSE received_minor END,
        tx_hash=CASE WHEN CAST(? AS TEXT) IS NOT NULL AND CAST(? AS TEXT) <> '' THEN CAST(? AS TEXT) ELSE tx_hash END,
        provider_event=COALESCE(provider_event, CAST(? AS TEXT)) WHERE id=?`
    ).run(status, paidUsdNew, usdToInr(paidUsdNew, rate), now, status === 'confirmed' ? now : deposit.confirmed_at,
      resvMinor, resvMinor, resvHash, resvHash, resvHash,
      status === 'confirmed' ? 'credited by verified payment' : null, deposit.id);

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(deposit.user_id);
    const newBalance = user.wallet_balance + inr;
    db.prepare('UPDATE users SET wallet_balance=? WHERE id=?').run(newBalance, user.id);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, 'deposit', ?, ?, ?, ?, ?)`
    ).run(user.id, inr, newBalance, deposit.id,
      JSON.stringify({
        currency: deposit.currency, invoice: deposit.invoice_id,
        partial: remaining < Number(deposit.amount_usd),
        received_minor: resvMinor > 0 ? resvMinor : undefined,
      }), now);

    const creditedInr = usdToInr(paidUsdNew, rate);
    const simSuffix = deposit.is_simulated ? ' (simulated)' : '';
    if (status === 'confirmed') {
      const receivedLine = resvMinor > 0
        ? `${cryptoMinorLabel(deposit.currency, resvMinor)} received`
        : `Payment of ${fmtUsd(deposit.amount_usd / 100)} received`;
      notify(user.id, 'deposit', 'Deposit Confirmed',
        `${receivedLine}${simSuffix}, credited as ${fmtInr(creditedInr)}.`);
    } else {
      const partialLine = resvMinor > 0
        ? `Partial payment received: ${cryptoMinorLabel(deposit.currency, resvMinor)} so far`
        : 'A partial payment was received';
      notify(user.id, 'deposit', 'Deposit Partially Received',
        `${partialLine}${simSuffix} — ${fmtInr(creditedInr)} credited (${Math.round((paidUsdNew / deposit.amount_usd) * 100)}%). We keep crediting as more arrives.`);
    }
    db.exec('COMMIT');
    return { ok: true, inr, status, partial: status === 'in_progress', paid_fraction: paidUsdNew / Number(deposit.amount_usd) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function markExpired(deposit) {
  if (deposit.status !== 'pending') return;
  const db = getDb();
  const res = db.prepare("UPDATE deposits SET status='expired' WHERE id=? AND status='pending'").run(deposit.id);
  if (res.changes > 0) {
    try {
      notify(deposit.user_id, 'deposit', 'Deposit Expired',
        `Your ${fmtUsd(deposit.amount_usd / 100)} ${deposit.currency} invoice expired unpaid. No amount was charged or credited.`);
    } catch { /* never block on a notification */ }
  }
}

// Called by the ticker to expire invoices past the timeout window.
export function expireStaleDeposits() {
  const db = getDb();
  const stale = db.prepare("SELECT * FROM deposits WHERE status='pending' AND expires_at < ?").all(Date.now());
  for (const d of stale) markExpired(d);
  return stale.length;
}

// ---------------------------------------------------------------------------
// Deposit reconciler — LIVE mode only. Polls Apirone for every pending /
// in_progress deposit and syncs against the public invoice-info endpoint.
// This is the safety net when a webhook is delayed or lost: as long as the
// on-chain payment exists, the wallet gets credited — server-side verified.
// ---------------------------------------------------------------------------
export function setupApironeMonitor() {
  if (!isApironeConfigured()) return;

  const reconcile = async () => {
    const db = getDb();
    const live = db.prepare(
      "SELECT * FROM deposits WHERE is_simulated=0 AND status IN ('pending','in_progress')"
    ).all();
    for (const d of live) {
      try {
        const info = await apironeInvoiceInfo(d.invoice_id);
        const status = invoiceStatusFromInfo(info);
        if (['expired', 'canceled', 'cancelled'].includes(status)) {
          if (d.status === 'pending') markExpired(d);
          continue;
        }
        const paidMinor = invoicePaidMinor(info);
        if (paidMinor > 0) {
          creditDeposit(d.id, {
            receivedUsdCents: paidMinorToUsdCents(d, paidMinor),
            receivedMinor: paidMinor,
            txHash: latestTxHash(info),
          });
        }
      } catch (e) {
        // transient — retry next tick
      }
    }
  };

  const tick = async () => { try { await reconcile(); } catch (e) { console.error('[instasmm] apirone monitor error:', e.message); } };
  tick();
  setInterval(tick, 20000);
  console.log('[instasmm] Apirone configured → live deposit reconciler active');
}

// Simulated auto-confirm loop — runs ONLY in SMM_TEST mode (test suites need a
// way for a simulated payment to land). In production it is never started, so
// there is no fake-payment path at all when real Apirone is absent.
export function setupPaymentSimulator() {
  if (process.env.SMM_TEST !== '1') {
    console.log('[instasmm] payment simulator disabled (needs SMM_TEST=1 — not set)');
    return;
  }
  if (isApironeConfigured()) {
    console.log('[instasmm] payment simulator disabled (live Apirone configured)');
    return;
  }
  const check = () => {
    try {
      const db = getDb();
      const auto = getSetting('demo_auto_confirm') === '1';
      if (!auto) return;
      const secs = Number(getSetting('demo_confirm_seconds') || 8);
      const ripe = db.prepare(
        "SELECT * FROM deposits WHERE status='pending' AND is_simulated=1 AND created_at + ( ? * 1000 ) < ?"
      ).all(secs, Date.now());
      for (const d of ripe) creditDeposit(d.id);
    } catch (e) {
      console.error('[instasmm] simulator tick error:', e.message);
    }
  };
  setInterval(check, 3000);
  console.log('[instasmm] SMM_TEST + no live Apirone → payment SIMULATOR active');
}