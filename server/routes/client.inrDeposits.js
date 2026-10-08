import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { createInrDeposit, claimInrDeposit, toClientView } from '../lib/inrDeposits.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(requireAuth);

// POST /api/deposits/inr — request an INR deposit (manual workflow).
// Creates a PENDING record only: no invoice, QR code, UPI ID or
// reference is ever fabricated, no payment is initiated and nothing is
// credited. The 10% customer surcharge comes from the shared INR math —
// the wallet will receive the CREDIT amount, never the surcharge-
// inclusive total. The operator issues the real UPI invoice (VCGetaway
// dashboard) out of band until an official API is documented.
r.post('/', ah(async (req, res) => {
  const invoiceRef = String(req.body?.invoice_ref || '').trim().slice(0, 200) || null;
  const out = createInrDeposit({ userId: req.user.id, rupees: req.body?.rupees, invoiceRef });
  if (!out.ok) return sendErr(res, 400, 'Enter a valid deposit amount in ₹.');
  return res.status(201).json({ deposit: toClientView(out.deposit) });
}));

// GET /api/deposits/inr — the client's own INR deposit requests.
r.get('/', (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM inr_deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
  ).all(req.user.id);
  return res.json({ deposits: rows.map(toClientView) });
});

// GET /api/deposits/inr/:id — own record only.
r.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM inr_deposits WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return sendErr(res, 404, 'Deposit not found.');
  return res.json({ deposit: toClientView(row) });
});

// POST /api/deposits/inr/:id/claim — the customer states "I have paid".
// This RECORDS the claim (status → awaiting_verification) and nothing
// else: a claim is never proof of payment and never credits the wallet.
// Only an admin verification of the actual payment can credit it.
r.post('/:id/claim', ah(async (req, res) => {
  const out = claimInrDeposit({ userId: req.user.id, depositId: req.params.id });
  if (!out.ok) {
    return sendErr(res, out.reason === 'not-found' ? 404 : 400,
      out.reason === 'not-found' ? 'Deposit not found.' : 'This deposit is no longer pending.');
  }
  return res.json({ deposit: toClientView(out.deposit) });
}));

export default r;
