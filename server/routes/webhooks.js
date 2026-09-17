import { Router } from 'express';
import { getDb } from '../db.js';
import {
  creditDeposit, isApironeConfigured,
  apironeInvoiceInfo, invoiceStatusFromInfo, invoicePaidMinor, paidMinorToUsdCents,
  latestTxHash,
  markExpired,
} from '../lib/apirone.js';
import { apironeCreds } from '../lib/apirone.js';
import { logSecurity } from '../middleware/auth.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(expressRaw());

function expressRaw() {
  return (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { req.body = data ? JSON.parse(data) : {}; } catch { req.body = {}; }
      next();
    });
  };
}

// ---------------------------------------------------------------------------
// POST /webhooks/apirone — Apirone v2 payment callback.
//
// The callback BODY is never trusted for the credit decision. We always fetch
// the invoice's authoritative state from Apirone's public invoice-info endpoint
// (status + cumulative received amounts) before crediting anything. The wallet
// is credited only for the server-verified received fraction, and exactly once
// per slice of funds.
//
// Returns a plain-text 200 OK so Apirone stops retrying.
// ---------------------------------------------------------------------------
r.post('/apirone', ah(async (req, res) => {
  const creds = apironeCreds();
  const headerToken = req.headers['x-apirone-token'] || req.headers['authorization']?.replace(/^bearer\s+/i, '');
  if (creds.webhook_token && headerToken !== creds.webhook_token) {
    logSecurity(null, null, 'apirone_webhook_bad_token', req.ip);
    return res.status(401).send('bad token');
  }

  const body = req.body || {};
  const invoiceId = String(body.invoice ?? body.payment_id ?? body.id ?? '');
  const db = getDb();
  if (!invoiceId) return res.status(200).type('text/plain').send('ok'); // nothing actionable

  const deposit = db.prepare('SELECT * FROM deposits WHERE invoice_id=?').get(invoiceId);
  if (!deposit) return res.status(200).type('text/plain').send('ok'); // unknown invoice — no-op

  // The payload is DATA (audit trail), never trusted for the credit decision.
  db.prepare('UPDATE deposits SET provider_event=? WHERE id=?')
    .run(JSON.stringify(body).slice(0, 1000), deposit.id);

  // ---- Server-side verification against Apirone's public endpoint ----
  try {
    const info = await apironeInvoiceInfo(invoiceId);
    const status = invoiceStatusFromInfo(info);
    const paidMinor = invoicePaidMinor(info);

    if (['expired', 'canceled', 'cancelled'].includes(status) && deposit.status === 'pending') {
      markExpired(deposit);
      return res.status(200).type('text/plain').send('ok');
    }

    if (paidMinor > 0) {
      const receivedUsd = paidMinorToUsdCents(deposit, paidMinor);
      const out = creditDeposit(deposit.id, {
        receivedUsdCents: receivedUsd,
        receivedMinor: paidMinor,
        txHash: latestTxHash(info),
      });
      if (out.ok) {
        const u = db.prepare('SELECT email FROM users WHERE id=?').get(deposit.user_id);
        logSecurity(deposit.user_id, u?.email, 'deposit_webhook',
          `apirone; invoice ${invoiceId}; verified paid ${paidMinor} minor; credited +${out.inr} INR (${out.paid_fraction * 100}%)`);
        db.prepare("UPDATE deposits SET provider_event=? WHERE id=?")
          .run(`server-verified: status ${status}; verified payment credited`.slice(0, 1000), deposit.id);
      }
    } else if (['paid', 'partpaid', 'overpaid', 'in_progress', 'processing', 'waiting'].includes(status) && deposit.status === 'pending') {
      // Non-final state, no (yet) receivable funds — mark in_progress, never credit.
      db.prepare("UPDATE deposits SET status='in_progress' WHERE id=?").run(deposit.id);
    }
  } catch (e) {
    // Verification failed — fail closed, credit nothing. Apirone will retry;
    // the reconciler is the backstop.
    console.error('[instasmm] apirone webhook verify failed:', e.message);
  }
  return res.status(200).type('text/plain').send('ok');
}));

// ---------------------------------------------------------------------------
// POST /webhooks/simulator — dev-only manual trigger to confirm a simulated
// deposit early. Reachable ONLY when BOTH (a) SMM_TEST=1 AND (b) Apirone is not
// configured: there is no simulator path in a production boot, and a real
// gateway is never involved with a simulated confirmation.
// ---------------------------------------------------------------------------
r.post('/simulator', (req, res) => {
  if (process.env.SMM_TEST !== '1') {
    return res.status(403).json({ error: 'simulator disabled (needs SMM_TEST=1)' });
  }
  if (isApironeConfigured()) return res.status(403).json({ error: 'simulator disabled in live mode' });
  const db = getDb();
  const id = Number(req.body?.deposit_id);
  if (!id) return res.status(400).json({ error: 'deposit_id required' });
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(id);
  if (!dep) return res.status(404).json({ error: 'deposit not found' });
  if (dep.is_simulated !== 1) return res.status(403).json({ error: 'only simulated deposits can be forced-confirmed' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'deposit already ' + dep.status });
  try {
    const out = creditDeposit(id);
    out.ok ? res.json({ ok: true, inr: out.inr }) : res.status(400).json({ error: out.reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default r;