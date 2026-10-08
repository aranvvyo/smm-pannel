import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin, logSecurity, clientIp } from '../middleware/auth.js';
import { verifyInrDeposit, denyInrDeposit, toClientView } from '../lib/inrDeposits.js';
import { fmtIST } from '../lib/ist.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

// GET /api/admin/deposits/inr — every INR deposit request, newest first.
r.get('/', (req, res) => {
  const rows = getDb().prepare(
    `SELECT d.*, u.email FROM inr_deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 300`
  ).all();
  return res.json({
    deposits: rows.map((d) => ({
      ...toClientView(d), email: d.email, verify_note: d.verify_note,
      verified_by: d.verified_by, created_ist: fmtIST(d.created_at),
    })),
  });
});

// GET /api/admin/deposits/inr/:id — full detail with the account email.
r.get('/:id', (req, res) => {
  const d = getDb().prepare(
    `SELECT d.*, u.email, u.name AS user_name FROM inr_deposits d JOIN users u ON u.id=d.user_id WHERE d.id=?`
  ).get(req.params.id);
  if (!d) return sendErr(res, 404, 'Deposit not found.');
  return res.json({
    deposit: {
      ...toClientView(d), email: d.email, user_name: d.user_name,
      verify_note: d.verify_note, verified_by: d.verified_by, created_ist: fmtIST(d.created_at),
    },
  });
});

// POST /api/admin/deposits/inr/:id/verify — MANUAL verification of the
// ACTUAL payment (against the VCGetaway dashboard / UPI confirmation).
// The admin must state what was verified — the reason is recorded in
// the audit trail and the security log. Credits the wallet the CREDIT
// amount (never the surcharge-inclusive total), exactly once,
// atomically with the ledger entry.
r.post('/:id/verify', ah(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) {
    return sendErr(res, 400, 'A reason is required to verify a deposit (audit trail).');
  }
  const paymentRef = String(req.body?.payment_ref || '').trim().slice(0, 200) || null;
  const invoiceRef = String(req.body?.invoice_ref || '').trim().slice(0, 200) || null;
  const out = verifyInrDeposit({
    adminId: req.user.id, depositId: req.params.id,
    paymentRef, invoiceRef, note: reason.slice(0, 300),
  });
  if (!out.ok) {
    if (out.reason === 'not-found') return sendErr(res, 404, 'Deposit not found.');
    return sendErr(res, 400, `Cannot verify: ${out.reason}`);
  }
  // Audit trail: the actor, the client address and the stated reason
  // are each recorded in their own column. Unexpected database
  // failures flow to the global error handler (generic 500) — the
  // deposit transaction has already rolled back, and no internal
  // detail is ever returned to the client.
  logSecurity(req.user.id, req.user.email, 'verify_inr_deposit', clientIp(req),
    `admin; reason: ${reason}; inr deposit #${req.params.id}; +${out.inr} INR`);
  return res.json({ ok: true, inr: out.inr });
}));

// POST /api/admin/deposits/inr/:id/deny — verification FAILED (payment
// not received / not matched). No credit, ever. The reason is recorded
// in the audit trail and the security log.
r.post('/:id/deny', ah(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) {
    return sendErr(res, 400, 'A reason is required to deny a deposit (audit trail).');
  }
  const out = denyInrDeposit({ adminId: req.user.id, depositId: req.params.id, reason: reason.slice(0, 300) });
  if (!out.ok) {
    if (out.reason === 'not-found') return sendErr(res, 404, 'Deposit not found.');
    return sendErr(res, 400, `Cannot deny: ${out.reason}`);
  }
  logSecurity(req.user.id, req.user.email, 'deny_inr_deposit', clientIp(req),
    `admin; reason: ${reason}; inr deposit #${req.params.id}`);
  return res.json({ ok: true });
}));

export default r;
