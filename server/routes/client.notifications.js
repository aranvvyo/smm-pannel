import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { unreadCount, listForUser } from '../lib/notifier.js';

const r = Router();

// GET /api/notifications — recent + unread count.
r.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const items = listForUser(req.user.id, 60).map((n) => ({
    id: n.id, type: n.type, title: n.title, body: n.body, read: Boolean(n.read_at), created_at: n.created_at,
  }));
  return res.json({ notifications: items, unread: unreadCount(req.user.id) });
});

// POST /api/notifications/:id/read
r.post('/:id/read', requireAuth, (req, res) => {
  getDb().prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(Date.now(), req.params.id, req.user.id);
  return res.json({ ok: true });
});

// POST /api/notifications/read-all
r.post('/read-all', requireAuth, (req, res) => {
  getDb().prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(Date.now(), req.user.id);
  return res.json({ ok: true });
});

export default r;