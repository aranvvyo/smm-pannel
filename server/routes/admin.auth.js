import { Router } from 'express';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { verifyPassword } from '../lib/passwords.js';
import { currentUser, requireAdmin, clientIp, logSecurity, startSession, logout } from '../middleware/auth.js';
import { sendErr } from './_helpers.js';

const r = Router();

// POST /api/admin/auth/login — admin-only gateway. The credential list is the
// hardcoded config — the DB can never elevate a client to an admin.
r.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);
  const clean = String(email || '').trim().toLowerCase();

  if (config.admins[clean] !== undefined && password !== config.admins[clean]) {
    const user = getDb().prepare('SELECT * FROM users WHERE email=?').get(clean);
    logSecurity(user?.id || null, clean, 'failed_admin_login', ip);
    return sendErr(res, 401, 'Invalid admin credentials.');
  }
  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE email=?').get(clean);
  if (!user) {
    // first login: create the admin account from config
    if (config.admins[clean] === undefined) return sendErr(res, 403, 'Forbidden.');
    const now = Date.now();
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
       VALUES (?,?,?,?,0,0,'active',0,?)`
    ).run(clean, '', 'admin', 'Admin', now);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
  }
  // configuration-aligned password check (handles both fresh + seeded admins)
  const ok = typeof config.admins[clean] === 'string'
    ? password === config.admins[clean]
    : verifyPassword(password, user.password_hash);

  if (!ok || user.status === 'banned') {
    logSecurity(user.id, user.email, 'blocked_admin_login', ip);
    return sendErr(res, 401, 'Invalid admin credentials.');
  }
  db.prepare(`UPDATE users SET role='admin', last_login_at=? WHERE id=?`).run(Date.now(), user.id);
  logSecurity(user.id, user.email, 'admin_login', ip);
  startSession(res, user, ip);
  return res.json({ user: safe(user) });
});

// GET /api/admin/auth/me
r.get('/me', requireAdmin, (req, res) => res.json({ user: safe(req.user) }));

// POST /api/admin/auth/logout
r.post('/logout', (req, res) => {
  const token = req.cookies?.instasmm_session;
  if (token) {
    const u = currentUser(req);
    if (u) logSecurity(u.id, u.email, 'admin_logout', clientIp(req));
    logout(token);
  }
  res.clearCookie('instasmm_session', { path: '/' });
  return res.json({ ok: true });
});

function safe(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

export default r;