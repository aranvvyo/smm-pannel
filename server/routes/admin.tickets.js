import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { notify } from '../lib/notifier.js';
import { sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

function dto(db, t) {
  return {
    ...t,
    replies: db.prepare('SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at').all(t.id),
  };
}

// GET /api/admin/tickets
r.get('/', (req, res) => {
  const db = getDb();
  const status = String(req.query.status || '');
  let sql = `SELECT t.*, u.email, o.order_ref FROM tickets t
             JOIN users u ON u.id=t.user_id
             LEFT JOIN orders o ON o.id = t.order_id`;
  const args = [];
  if (status && status !== 'ALL') { sql += ' WHERE t.status=?'; args.push(status); }
  sql += ' ORDER BY t.updated_at DESC LIMIT 300';
  const rows = db.prepare(sql).all(...args);
  return res.json({ tickets: rows.map((t) => dto(db, t)) });
});

// GET /api/admin/tickets/:id
r.get('/:id', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return sendErr(res, 404, 'Ticket not found.');
  return res.json({ ticket: dto(db, t) });
});

// POST /api/admin/tickets/:id/reply
r.post('/:id/reply', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return sendErr(res, 404, 'Ticket not found.');
  const body = String(req.body?.body || '').trim();
  if (!body) return sendErr(res, 400, 'Message is required.');
  db.prepare('INSERT INTO ticket_replies (ticket_id, user_id, sender_role, body, created_at) VALUES (?,?,?,?,?)')
    .run(t.id, req.user.id, 'admin', body, Date.now());
  db.prepare("UPDATE tickets SET status='pending', updated_at=? WHERE id=?").run(Date.now(), t.id);
  notify(t.user_id, 'ticket', 'Support Reply', `Admin replied to “${t.subject}”.`);
  return res.json({ ticket: dto(db, db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id)) });
});

// POST /api/admin/tickets/:id/status  {status: open|pending|closed}
r.post('/:id/status', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return sendErr(res, 404, 'Ticket not found.');
  const status = String(req.body?.status || 'open');
  if (!['open', 'pending', 'closed'].includes(status)) return sendErr(res, 400, 'Invalid status.');
  db.prepare('UPDATE tickets SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), t.id);
  if (status === 'closed') {
    notify(t.user_id, 'ticket', 'Ticket Closed', `“${t.subject}” has been closed. Reply to reopen.`);
  }
  return res.json({ ticket: dto(db, db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id)) });
});

export default r;