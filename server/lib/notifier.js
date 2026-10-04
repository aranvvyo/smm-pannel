import { getDb } from '../db.js';

// In-app notification service. user_id 0 = broadcast (all CLIENT users).
export function notify(userId, type, title, body = '') {
  const db = getDb();
  const users = userId > 0 ? [userId] : db.prepare(`SELECT id FROM users WHERE role='client'`).all().map(r => r.id);
  const ins = db.prepare('INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (?,?,?,?,?)');
  for (const uid of users) ins.run(uid, type, title, body, Date.now());
  return true;
}

// Staff-only notification (admins). Never broadcast to clients —
// used for support-ticket events that contain user email addresses.
export function notifyAdmins(type, title, body = '') {
  const db = getDb();
  const admins = db.prepare(`SELECT id FROM users WHERE role='admin'`).all();
  const ins = db.prepare('INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (?,?,?,?,?)');
  for (const a of admins) ins.run(a.id, type, title, body, Date.now());
  return true;
}

export function listForUser(userId, limit = 50) {
  return getDb().prepare(
    `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit);
}

export function unreadCount(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId).c;
}