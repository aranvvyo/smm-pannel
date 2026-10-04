import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import {
  currentUser, requireAdmin, clientIp, rateLimitIp, logSecurity,
  startSession, logout, checkRateLimit, recordAttempt, clearAttempts,
} from '../middleware/auth.js';
import { sendErr } from './_helpers.js';

const r = Router();

// Constant-time comparison for the hardcoded config passwords —
// plain === short-circuits on the first differing byte.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// POST /api/admin/auth/login — admin-only gateway. The credential list is the
// hardcoded config — the DB can never elevate a client to an admin.
r.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);
  const clean = String(email || '').trim().toLowerCase();

  // Admin credentials are high-value: the same 5-attempts / 15-min
  // throttle as client login, keyed on the UNSPOOFABLE socket
  // address (X-Forwarded-For must never gate a security decision).
  const throttleKey = `adm:${clean}|${rateLimitIp(req)}`;

  // Admin access is locked to the config list — a non-listed email
  // (including an existing CLIENT account) can never authenticate
  // here, and a client's DB password must never promote a row: the
  // DB role column can never widen privilege.
  const listed = typeof config.admins[clean] === 'string';
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(clean);

  if (!listed) {
    if (!checkRateLimit(throttleKey)) {
      logSecurity(null, clean, 'admin_login_rate_limited', ip);
      return sendErr(res, 429, 'Too many attempts. Try again in a few minutes.');
    }
    recordAttempt(throttleKey);
    logSecurity(user?.id || null, clean, 'failed_admin_login', ip);
    return sendErr(res, 403, 'Forbidden.');
  }

  // Verify FIRST. A correct credential is never throttled: the
  // throttle slows wrong-password guessing — it must not lock the
  // legitimate owner out of their own account (a wrong-password
  // flood from anyone who knows the admin email would otherwise be
  // a built-in denial of service). Only failures are counted and
  // throttled, so brute-force protection is unchanged: 5 failures
  // per 15-minute window per (admin email, socket address), and a
  // full bucket answers 429 exactly as before.
  const passwordOk = safeEqual(password, config.admins[clean]);

  if (passwordOk) {
    let admin = user;
    if (!admin) {
      // First-ever login for a listed admin: create the account
      // from config — only after the password verified.
      const now = Date.now();
      const info = db.prepare(
        `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
         VALUES (?,?,?,?,0,0,'active',0,?)`
      ).run(clean, '', 'admin', 'Admin', now);
      admin = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
    }
    if (admin.status === 'banned') {
      logSecurity(admin.id, admin.email, 'blocked_admin_login', ip);
      recordAttempt(throttleKey);
      return sendErr(res, 401, 'Invalid admin credentials.');
    }
    clearAttempts(throttleKey);
    db.prepare(`UPDATE users SET role='admin', last_login_at=? WHERE id=?`).run(Date.now(), admin.id);
    logSecurity(admin.id, admin.email, 'admin_login', ip);
    startSession(res, admin, ip);
    return res.json({ user: safe(admin) });
  }

  // Wrong password for a listed admin — count the failure, and
  // throttle once the bucket is full (the 6th failure within the
  // 15-minute window answers 429 without recording again).
  if (!checkRateLimit(throttleKey)) {
    logSecurity(null, clean, 'admin_login_rate_limited', ip);
    return sendErr(res, 429, 'Too many attempts. Try again in a few minutes.');
  }
  recordAttempt(throttleKey);
  logSecurity(user?.id || null, clean, 'failed_admin_login', ip);
  return sendErr(res, 401, 'Invalid admin credentials.');
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