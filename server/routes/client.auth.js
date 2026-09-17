import { Router } from 'express';
import { getDb } from '../db.js';
import { hashPassword, verifyPassword, isValidEmail } from '../lib/passwords.js';
import {
  startSession, logout, requireAuth, roleForEmail,
  clientIp, logSecurity, currentUser, checkRateLimit, recordAttempt, clearAttempts,
} from '../middleware/auth.js';
import { notify } from '../lib/notifier.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();

function tryLogin(req, res, treatAsAdmin) {
  const { email, password } = req.body || {};
  const ip = clientIp(req);
  const key = `${treatAsAdmin ? 'adm:' : ''}${String(email).toLowerCase()}|${ip}`;
  if (!checkRateLimit(key)) {
    return sendErr(res, 429, 'Too many attempts. Try again in a few minutes.');
  }
  if (!email || !password) { recordAttempt(key); return sendErr(res, 400, 'Email and password required.'); }

  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email).trim().toLowerCase());

  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAttempt(key);
    logSecurity(user?.id || null, email, 'failed_login', ip);
    return sendErr(res, 401, 'Invalid email or password.');
  }

  // Admin access is locked to the config list — even if a DB row exists.
  const effectiveRole = roleForEmail(user.email);
  if (treatAsAdmin && effectiveRole !== 'admin') {
    logSecurity(user.id, user.email, 'failed_admin_login', ip);
    return sendErr(res, 403, 'Forbidden.');
  }
  if (!treatAsAdmin && effectiveRole === 'admin') {
    logSecurity(user.id, user.email, 'failed_client_login', ip);
    return sendErr(res, 403, 'Admins must sign in from the admin portal.');
  }
  if (user.status === 'banned') {
    logSecurity(user.id, user.email, 'blocked_banned_login', ip);
    return sendErr(res, 403, 'Account is disabled. Contact support.');
  }

  clearAttempts(key);
  // Keep role in sync with config — the DB column can never widen privilege.
  db.prepare('UPDATE users SET role=?, last_login_at=? WHERE id=?').run(effectiveRole, Date.now(), user.id);
  logSecurity(user.id, user.email, 'login', ip);
  startSession(res, user, ip);
  return res.json({ user: publicUser(user, effectiveRole) });
}

function publicUser(user, role) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: role || user.role,
    status: user.status,
    no_profit: user.no_profit,
    wallet_inr: user.wallet_balance,
  };
}

// POST /api/auth/register
r.post('/register', (req, res) => {
  const { email, password, confirm, terms, name } = req.body || {};
  if (!terms) return sendErr(res, 400, 'You must accept the Terms & Conditions.');
  if (!isValidEmail(email)) return sendErr(res, 400, 'Please enter a valid email address.');
  if (!password || password.length < 6) return sendErr(res, 400, 'Password must be at least 6 characters.');
  if (password !== confirm) return sendErr(res, 400, 'Passwords do not match.');

  const cleanEmail = String(email).trim().toLowerCase();
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(cleanEmail);
  if (exists) return sendErr(res, 409, 'An account with this email already exists.');

  // Admin emails can only be created from config — a signup with that email
  // is still forbidden to protect the hardcoded privilege boundary.
  const role = roleForEmail(cleanEmail);
  if (role === 'admin') return sendErr(res, 403, 'Registration closed for this email.');

  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at) VALUES (?,?,?,?,0,0,\'active\',0,?)'
  ).run(cleanEmail, hashPassword(password), 'client', name || null, now);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));

  logSecurity(user.id, user.email, 'register', clientIp(req));
  notify(user.id, 'admin', 'Welcome to InstaSMM', 'Your account is ready. Top up your wallet and place your first order!');
  startSession(res, user, 'client');
  return res.json({ user: publicUser(user, 'client') });
});

// POST /api/auth/login
r.post('/login', (req, res) => tryLogin(req, res, false));

// POST /api/auth/logout
r.post('/logout', (req, res) => {
  const token = req.cookies?.instasmm_session;
  if (token) {
    logout(token);
    const user = currentUser(req);
    if (user) logSecurity(user.id, user.email, 'logout', clientIp(req));
  }
  res.clearCookie('instasmm_session', { path: '/' });
  return res.json({ ok: true });
});

// GET /api/auth/me
r.get('/me', requireAuth, (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

// POST /api/auth/password — change password WITHOUT the old one (account
// recovery flow). New password is scrypt-hashed (never stored plain) and ALL
// existing sessions are revoked so the user signs in again with the new one.
r.post('/password', requireAuth, (req, res) => {
  const { new_password, confirm } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return sendErr(res, 400, 'New password must be at least 6 characters.');
  }
  if (new_password !== confirm) {
    return sendErr(res, 400, 'Passwords do not match.');
  }
  const db = getDb();
  const newHash = hashPassword(String(new_password));
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, req.user.id);
  // Invalidate every session for this account (including this one).
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
  logSecurity(req.user.id, req.user.email, 'password_change', clientIp(req));
  notify(req.user.id, 'account', 'Password Changed',
    'Your password was updated. Please sign in again with your new password.');
  res.clearCookie('instasmm_session', { path: '/' });
  return res.json({ ok: true });
});

export default r;