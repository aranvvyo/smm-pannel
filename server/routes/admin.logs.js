import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { fmtIST } from '../lib/ist.js';

const r = Router();
r.use(requireAdmin);

// GET /api/admin/logs — security/audit feed with IST timestamps + IP.
r.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = getDb().prepare(
    `SELECT * FROM security_logs ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
  return res.json({ logs: rows.map((l) => ({ ...l, created_ist: fmtIST(l.created_at) })) });
});

export default r;