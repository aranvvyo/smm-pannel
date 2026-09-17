import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin, logSecurity } from '../middleware/auth.js';
import { adminAdjustBalance } from '../lib/wallet.js';
import { notify } from '../lib/notifier.js';
import { sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

function userCell(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

// GET /api/admin/users — filtered list with spend/profit summaries.
r.get('/', (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db.prepare(
        `SELECT * FROM users WHERE role='client' AND (email LIKE ? OR name LIKE ?)
         ORDER BY created_at DESC LIMIT 200`
      ).all(`%${q}%`, `%${q}%`)
    : db.prepare(`SELECT * FROM users WHERE role='client' ORDER BY created_at DESC LIMIT 200`).all();

  const spend = db.prepare(`SELECT user_id, COUNT(*) orders, COALESCE(SUM(price_inr - base_cost_inr),0) profit
                            FROM orders GROUP BY user_id`);
  const spendMap = new Map(spend.all().map((s) => [s.user_id, s]));

  const list = rows.map((u) => {
    const s = spendMap.get(u.id) || { orders: 0, profit: 0 };
    return { ...userCell(u), order_count: s.orders, profit_inr: s.profit };
  });
  return res.json({ users: list });
});

// GET /api/admin/users/:id
r.get('/:id', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return sendErr(res, 404, 'User not found.');
  const tx = db.prepare('SELECT id,type,amount_inr,balance_after,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id);
  return res.json({ user: userCell(u), transactions: tx });
});

// POST /api/admin/users/:id/balance  { amount }  (INR, signed, in rupees)
r.post('/:id/balance', (req, res) => {
  const amount = Math.round(Number(req.body?.amount) * 100); // paise
  if (!Number.isFinite(amount) || amount === 0) return sendErr(res, 400, 'Enter a non-zero amount in INR.');
  try {
    const out = adminAdjustBalance(req.user, req.params.id, amount);
    return res.json(out);
  } catch (e) {
    return sendErr(res, 400, e.message, e.code);
  }
});

// POST /api/admin/users/:id/ban  { banned: true|false }
r.post('/:id/ban', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return sendErr(res, 404, 'User not found.');
  if (u.role === 'admin') return sendErr(res, 400, 'Admins cannot be banned.');
  const banned = Boolean(req.body?.banned);
  db.prepare('UPDATE users SET status=? WHERE id=?').run(banned ? 'banned' : 'active', u.id);
  // Kill their sessions on ban.
  if (banned) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  logSecurity(req.user.id, req.user.email, banned ? 'ban' : 'unban', 'admin');
  notify(u.id, 'account', banned ? 'Account Suspended' : 'Account Re-activated',
    banned ? 'Your account has been disabled. Contact support for details.' : 'Your account has been re-activated.');
  return res.json({ banned });
});

// POST /api/admin/users/:id/no-profit { enabled: true|false }
r.post('/:id/no-profit', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return sendErr(res, 404, 'User not found.');
  const enabled = Boolean(req.body?.enabled);
  db.prepare('UPDATE users SET no_profit=? WHERE id=?').run(enabled ? 1 : 0, u.id);
  logSecurity(req.user.id, req.user.email, enabled ? 'add_no_profit' : 'remove_no_profit', 'admin');
  // Spec: notification ONLY when adding — never when removing.
  if (enabled) {
    notify(u.id, 'admin', "Added to Owner's Favourite List",
      "You've been added to the owner's favourite list — you now get services at base (no-profit) prices.");
  }
  return res.json({ no_profit: enabled });
});

export default r;