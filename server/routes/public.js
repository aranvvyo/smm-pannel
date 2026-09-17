import { Router } from 'express';
import { getDb } from '../db.js';
import { platformStats } from '../lib/analytics.js';

const r = Router();

// GET /api/landing/stats — public counters for the landing page.
r.get('/landing/stats', (req, res) => {
  const db = getDb();
  const clients = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='client'`).get().c;
  const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const services = db.prepare('SELECT COUNT(*) c FROM services WHERE status=1').get().c;
  const completed = db.prepare(`SELECT COUNT(*) c FROM orders WHERE status IN ('COMPLETED','PARTIAL')`).get().c;
  return res.json({ clients, orders, services, completed });
});

// GET /api/landing/services — a few showcase services (public, safe pricing only).
r.get('/landing/services', (req, res) => {
  const svcs = getDb().prepare(
    `SELECT s.name, s.speed_hint, s.min, s.max, s.admin_rate, c.name AS category, c.icon
     FROM services s JOIN categories c ON c.id = s.category_id
     WHERE s.status=1 ORDER BY RANDOM() LIMIT 8`
  ).all();
  return res.json({ services: svcs.map((s) => ({
    name: s.name, category: s.category, icon: s.icon, speed: s.speed_hint,
    min: s.min, max: s.max, price_per_1k: Math.round(s.admin_rate),
  })) });
});

export default r;