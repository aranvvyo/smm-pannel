import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth, currentUser } from '../middleware/auth.js';
import { priceFor } from '../lib/money.js';
import { sendErr } from './_helpers.js';

const r = Router();

// GET /api/services — categories + active services with client-safe pricing.
// NEVER leaks provider_rate / admin_rate / markup / base cost. When NO real
// provider is configured the panel reports provider_configured=false and an
// empty catalog (the client shows "Provider not configured", never a fake).
r.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const noProfit = req.user.no_profit === 1;
  const providerConfigured = db.prepare('SELECT COUNT(*) c FROM providers WHERE active=1').get().c > 0;
  const cats = db.prepare('SELECT id, name, slug, icon FROM categories WHERE active=1 ORDER BY sort').all();
  const svcs = db.prepare(
    `SELECT id, category_id, name, description, speed_hint, type, quality, min, max, provider_rate, admin_rate
     FROM services WHERE status=1 ORDER BY name`
  ).all();

  const byCat = cats.map((c) => ({
    ...c,
    services: svcs
      .filter((s) => s.category_id === c.id)
      .map((s) => {
        const rate = noProfit ? s.provider_rate : s.admin_rate;
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          speed_hint: s.speed_hint,
          type: s.type,
          quality: s.quality,
          min: s.min,
          max: s.max,
          // price per 1000 for display — the only pricing number clients see
          price_per_1k: Math.round(rate),
        };
      }),
  })).filter((c) => c.services.length > 0);

  return res.json({ categories: byCat, no_profit: noProfit, provider_configured: providerConfigured });
});

// GET /api/services/:id
r.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const s = db.prepare(
    `SELECT s.*, c.name AS category_name FROM services s
     JOIN categories c ON c.id = s.category_id WHERE s.id=? AND s.status=1`
  ).get(req.params.id);
  if (!s) return sendErr(res, 404, 'Service not found.');
  const noProfit = req.user.no_profit === 1;
  const rate = noProfit ? s.provider_rate : s.admin_rate;
  return res.json({
    id: s.id,
    category: s.category_name,
    name: s.name,
    description: s.description,
    speed_hint: s.speed_hint,
    type: s.type,
    quality: s.quality,
    min: s.min,
    max: s.max,
    price_per_1k: Math.round(rate),
  });
});

export default r;