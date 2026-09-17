import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { notify } from '../lib/notifier.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();

function ticketDTO(db, t) {
  const replies = db.prepare(
    `SELECT id, user_id, sender_role, body, created_at FROM ticket_replies WHERE ticket_id=? ORDER BY created_at`
  ).all(t.id);
  return { ...t, replies };
}

// GET /api/tickets — own tickets with replies + order refs.
r.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.*, o.order_ref
     FROM tickets t LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.user_id=? ORDER BY t.updated_at DESC`
  ).all(req.user.id);
  return res.json({ tickets: rows.map((t) => ticketDTO(db, t)) });
});

// POST /api/tickets — open a ticket (optional attached order).
r.post('/', requireAuth, (req, res) => {
  const { subject, body, order_id } = req.body || {};
  if (!subject || !String(subject).trim()) return sendErr(res, 400, 'Subject is required.');
  if (!body || !String(body).trim()) return sendErr(res, 400, 'Message is required.');

  const db = getDb();
  if (order_id) {
    const owns = db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(order_id, req.user.id);
    if (!owns) return sendErr(res, 400, 'You can only attach your own order.');
  }
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO tickets (user_id, subject, order_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(req.user.id, String(subject).trim(), order_id || null, 'open', now, now);
  db.prepare('INSERT INTO ticket_replies (ticket_id, user_id, sender_role, body, created_at) VALUES (?,?,?,?,?)')
    .run(Number(info.lastInsertRowid), req.user.id, 'client', String(body).trim(), now);
  notify(0, 'admin', 'New Support Ticket', `${req.user.email} opened “${String(subject).trim()}”.`);
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(info.lastInsertRowid));
  return res.status(201).json({ ticket: ticketDTO(db, t) });
});

// POST /api/tickets/:id/reply — user replies to own ticket.
r.post('/:id/reply', requireAuth, (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!t) return sendErr(res, 404, 'Ticket not found.');
  if (t.status === 'closed') return sendErr(res, 400, 'This ticket is closed.');
  const body = String(req.body?.body || '').trim();
  if (!body) return sendErr(res, 400, 'Message is required.');
  db.prepare('INSERT INTO ticket_replies (ticket_id, user_id, sender_role, body, created_at) VALUES (?,?,?,?,?)')
    .run(t.id, req.user.id, 'client', body, Date.now());
  db.prepare("UPDATE tickets SET status='open', updated_at=? WHERE id=?").run(Date.now(), t.id);
  notify(0, 'admin', 'Ticket Reply', `${req.user.email} replied to “${t.subject}”.`);
  return res.json({ ticket: ticketDTO(db, db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id)) });
});

export default r;