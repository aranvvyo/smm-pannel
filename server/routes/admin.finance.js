import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin, logSecurity } from '../middleware/auth.js';
import { profitMetrics, depositStats, dailySeries, platformStats } from '../lib/analytics.js';
import { creditDeposit } from '../lib/apirone.js';
import { fmtIST } from '../lib/ist.js';
import { sendErr } from './_helpers.js';

const dashboardRouter = Router();
dashboardRouter.use(requireAdmin);

// GET /api/admin/dashboard — everything for the admin home screen.
dashboardRouter.get('/', (req, res) => {
  const db = getDb();
  return res.json({
    metrics: {
      ...profitMetrics(),
      ...depositStats(),
    },
    platform: platformStats(),
    series: dailySeries(14),
    recentOrders: db.prepare(
      `SELECT o.order_ref, o.status, o.price_inr, o.created_at, u.email, s.name AS service_name
       FROM orders o JOIN users u ON u.id=o.user_id JOIN services s ON s.id=o.service_id
       ORDER BY o.created_at DESC LIMIT 8`
    ).all(),
    recentDeposits: db.prepare(
      `SELECT d.id, d.amount_usd, d.amount_inr, d.currency, d.status, d.created_at, u.email
       FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 8`
    ).all(),
  });
});

const depositsRouter = Router();
depositsRouter.use(requireAdmin);

// GET /api/admin/deposits
depositsRouter.get('/', (req, res) => {
  const rows = getDb().prepare(
    `SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 300`
  ).all();
  return res.json({ deposits: rows.map((d) => ({ ...d, created_ist: fmtIST(d.created_at) })) });
});

// GET /api/admin/deposits/:id — full single-deposit detail for the verify
// screen: every status, the upstream payment event, and the account email.
depositsRouter.get('/:id', (req, res) => {
  const d = getDb().prepare(
    `SELECT d.*, u.email, u.name AS user_name
     FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.id=?`
  ).get(req.params.id);
  if (!d) return sendErr(res, 404, 'Deposit not found.');
  return res.json({ deposit: { ...d, created_ist: fmtIST(d.created_at) } });
});

// POST /api/admin/deposits/:id/confirm — MANUAL confirm. Never acts on a
// deposit that already reached a terminal status, and the operator must state
// WHY (the reason is recorded in the security audit trail). A blind confirm
// (no reason) is rejected with 400. Creating an invoice never auto-credits —
// this is the only manual path, and it stays explicit + audited.
depositsRouter.post('/:id/confirm', (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) {
    return sendErr(res, 400, 'A reason is required to confirm a deposit (audit trail).');
  }
  try {
    const out = creditDeposit(req.params.id);
    if (!out.ok) return sendErr(res, 400, `Cannot confirm: ${out.reason}`);
    logSecurity(req.user.id, req.user.email, 'manual_confirm_deposit',
      `admin; reason: ${reason}; deposit #${req.params.id}; +${out.inr} INR`);
    return res.json({ ok: true, inr: out.inr });
  } catch (e) {
    return sendErr(res, 500, e.message);
  }
});

// POST /api/admin/deposits/:id/dismiss — mark a deposit as rejected/void. Only
// for non-terminal deposits that have NOT received any funds. The reason is
// required and recorded in the security audit trail. A dismissed invoice can
// never auto-credit again.
depositsRouter.post('/:id/dismiss', (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) {
    return sendErr(res, 400, 'A reason is required to dismiss a deposit (audit trail).');
  }
  const db = getDb();
  const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!d) return sendErr(res, 404, 'Deposit not found.');
  if (['confirmed', 'rejected', 'expired'].includes(d.status)) {
    return sendErr(res, 400, `Deposit is already ${d.status}.`);
  }
  if (Number(d.paid_usd || 0) > 0) {
    return sendErr(res, 400, 'This deposit already received funds — do NOT dismiss. Issue a manual confirm or a refund instead.');
  }
  db.prepare(
    "UPDATE deposits SET status='rejected', reject_reason=?, amount_inr=0, confirmed_at=? WHERE id=?"
  ).run(reason.slice(0, 300), Date.now(), d.id);
  logSecurity(req.user.id, req.user.email, 'dismiss_deposit',
    `admin; reason: ${reason}; deposit #${d.id} (invoice ${d.invoice_id})`);
  return res.json({ ok: true });
});

export { dashboardRouter, depositsRouter };