import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { createInrDeposit, claimInrDeposit, toClientView } from '../lib/inrDeposits.js';
import { verifyDepositOnce } from '../lib/inrVerification.js';
import { ah, sendErr } from './_helpers.js';
import { assertDepositsOpen } from '../lib/depositMaintenance.js';

// Maintenance gate for STARTING an INR request or payment claim. Reads, the
// status check of an existing deposit, and admin review are never blocked.
function inrMaintenance(res) {
  try { assertDepositsOpen('inr'); return null; }
  catch (e) { return sendErr(res, 503, e.message, e.code); }
}

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
  const blocked = inrMaintenance(res);
  if (blocked) return blocked;
  const invoiceRef = String(req.body?.invoice_ref || '').trim().slice(0, 200) || null;
  const out = createInrDeposit({ userId: req.user.id, rupees: req.body?.rupees, invoiceRef });
  if (!out.ok && out.reason === 'below-minimum') return sendErr(res, 400, 'The minimum deposit is ₹1.00.');
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
  const blocked = inrMaintenance(res);
  if (blocked) return blocked;
  const out = claimInrDeposit({ userId: req.user.id, depositId: req.params.id });
  if (!out.ok) {
    return sendErr(res, out.reason === 'not-found' ? 404 : 400,
      out.reason === 'not-found' ? 'Deposit not found.' : 'This deposit is no longer pending.');
  }
  return res.json({ deposit: toClientView(out.deposit) });
}));

// POST /api/deposits/inr/:id/check — the customer asks the server to re-check
// the payment with the provider. This is a server-side status check only. It
// never credits from the request itself, and it reports the provider state
// honestly. While the verification contract is unconfirmed the state is
// "unavailable" and the deposit stays pending.
// In-memory limits (per process). They protect the provider from request
// floods; they are not a security boundary and do not need to be durable.
const CHECK_COOLDOWN_MS = 15_000;          // per deposit
const CHECK_USER_WINDOW_MS = 10 * 60_000;  // per user, sliding window
const CHECK_USER_MAX = 20;
const lastCheckByDeposit = new Map();      // depositId -> timestamp
const checksByUser = new Map();            // userId -> [timestamps]
function checkRateLimited(userId, depositId, now = Date.now()) {
  const last = lastCheckByDeposit.get(depositId);
  if (last !== undefined && now - last < CHECK_COOLDOWN_MS) return true;
  const recent = (checksByUser.get(userId) || []).filter((t) => now - t < CHECK_USER_WINDOW_MS);
  if (recent.length >= CHECK_USER_MAX) { checksByUser.set(userId, recent); return true; }
  recent.push(now);
  checksByUser.set(userId, recent);
  lastCheckByDeposit.set(depositId, now);
  return false;
}

r.post('/:id/check', ah(async (req, res) => {
  const own = getDb().prepare('SELECT id FROM inr_deposits WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!own) return sendErr(res, 404, 'Deposit not found.');
  if (checkRateLimited(req.user.id, own.id)) {
    return sendErr(res, 429, 'Please wait a little before checking this payment again.');
  }
  const out = await verifyDepositOnce({ depositId: own.id });
  const row = getDb().prepare('SELECT * FROM inr_deposits WHERE id=? AND user_id=?').get(own.id, req.user.id);
  return res.json({
    deposit: toClientView(row),
    verification: { state: out.state, credited: out.credited === true },
  });
}));

export default r;
