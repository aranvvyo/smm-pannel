import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';

const COOKIE_NAME = 'instasmm_session';

// ---------------------------------------------------------------------------
// Session + role authorization.
//   - HttpOnly, SameSite=strict, persistent ~30d cookie.
//   - Session token stored hashed (SHA-256) in DB.
//   - Admin gate is strictly enforced here AND by mounting admin routers under
//     /api/admin with this guard first — a client session can never touch them.
// ---------------------------------------------------------------------------

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Session cookie options. Secure by default: the production site is served over
// HTTPS, and a Secure cookie is never sent over plain HTTP. COOKIE_SECURE=0 is
// for local plain-HTTP development only. Set it nowhere in production.
export function sessionCookieOptions(maxAge, env = process.env) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE !== '0',
    maxAge,
    path: '/',
  };
}

export function startSession(res, user, ip) {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const expires = Date.now() + config.sessionTtlMs;
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  db.prepare('INSERT INTO sessions (token_hash, user_id, ip, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(tokenHash(token), user.id, ip, expires, Date.now());
  res.cookie(COOKIE_NAME, token, sessionCookieOptions(config.sessionTtlMs));
}

export function logout(sessionToken) {
  if (!sessionToken) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(sessionToken));
}

// Read current session user from request cookie (no DB write). Returns user row
// or null. Also enforces ban.
export function currentUser(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const row = getDb().prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=? AND s.expires_at > ?`
  ).get(tokenHash(token), Date.now());
  if (!row) return null;
  if (row.status === 'banned') return null; // banned sessions are dead
  return row;
}

// Compute the effective role for an email. Admin status is locked to the
// hardcoded config list — the DB role column can never widen access.
export function roleForEmail(email) {
  return email in config.admins ? 'admin' : 'client';
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  // Hard gate: force admin email check, not just the DB role flag.
  if (user.role !== 'admin' || !(user.email in config.admins)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  req.user = user;
  next();
}

// ---------------------------------------------------------------------------
// Login throttling (in-memory, lightweight). 5 attempts / 15 min per key.
// ---------------------------------------------------------------------------
const attempts = new Map();
function prune() {
  const cut = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of attempts) if (v.ts < cut) attempts.delete(k);
}
export function checkRateLimit(key) {
  prune();
  const rec = attempts.get(key);
  if (rec && rec.count >= 5 && Date.now() - rec.ts < 15 * 60 * 1000) return false;
  return true;
}
export function recordAttempt(key) {
  prune();
  const rec = attempts.get(key);
  attempts.set(key, { count: (rec?.count || 0) + 1, ts: Date.now() });
}
export function clearAttempts(key) {
  attempts.delete(key);
}

export function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim())
    || req.socket?.remoteAddress
    || 'unknown';
}

// Unspoofable client address for SECURITY decisions (login
// throttling). X-Forwarded-For is attacker-controlled and may
// only ever feed audit logs — never a rate-limit key.
export function rateLimitIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// `detail` (optional) carries audit context — the stated reason,
// deposit references, amounts — for events that require one. It is
// stored in its own column so `ip` always holds an address.
export function logSecurity(userId, email, action, ip, detail = null) {
  getDb().prepare('INSERT INTO security_logs (user_id, email, action, ip, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId || null, email || null, action, ip || null, detail, Date.now());
}