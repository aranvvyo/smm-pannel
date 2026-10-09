import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth, currentUser } from '../middleware/auth.js';
import { priceFor, displayRatePer1k } from '../lib/money.js';
import { canonicalizeCategories } from '../lib/providerSync.js';
import { sendErr } from './_helpers.js';

const r = Router();

// Synthetic id for active services whose category row is missing
// or inactive. They are grouped under "Uncategorized" so they are
// never silently dropped from the client catalog. Purely a
// display/filter key — order placement uses the service id, never
// the category id.
const UNCATEGORIZED_ID = 0;

// Map a service row to the client-safe shape (never leaks
// provider_rate / admin_rate / markup / base cost).
function mapService(s, noProfit) {
  const rate = noProfit ? s.provider_rate : s.admin_rate;
  return {
    id: s.id,
    category_id: s.category_id,
    provider_service_id: s.provider_service_id,
    name: s.name,
    description: s.description,
    speed_hint: s.speed_hint,
    type: s.type,
    quality: s.quality,
    min: s.min,
    max: s.max,
    // Client-safe capability flags (admin route already exposes these).
    refill: Number(s.refill),
    cancel: Number(s.cancel),
    // price per 1000 for display — the only pricing number clients see.
    // Rupees with decimals kept (a whole-rupee round made ₹0.45 show ₹0.00).
    price_per_1k: displayRatePer1k(rate),
  };
}

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

  // Deduplicate category rows that share a normalized name (e.g. a
  // legacy `srvc-*` row and a canonical `cat-*` row). Each logical
  // category appears exactly once and its services are merged under
  // the canonical row, so a category never shows twice and its
  // services are never split across duplicate labels.
  const { canonical, canonicalOf } = canonicalizeCategories(cats);

  // Every category id that exists in the table (active or not).
  // Used to tell a DELETED category (orphan → Uncategorized) from
  // an intentionally INACTIVE one (its services stay hidden with it).
  const allCatIds = new Set(
    db.prepare('SELECT id FROM categories').all().map((c) => c.id)
  );

  const servicesByCat = new Map(); // canonical id -> mapped services
  const orphanServices = [];
  for (const s of svcs) {
    const canonicalCat = canonicalOf.get(s.category_id);
    if (canonicalCat) {
      // Present the service under its CANONICAL category id so the
      // client's category filter (category_id === selectedId) matches
      // even when the service was stored under a duplicate row.
      const mapped = mapService(s, noProfit);
      if (!servicesByCat.has(canonicalCat.id)) servicesByCat.set(canonicalCat.id, []);
      servicesByCat.get(canonicalCat.id).push({ ...mapped, category_id: canonicalCat.id });
    } else if (!allCatIds.has(s.category_id)) {
      // The category row was DELETED — surface the active service
      // under "Uncategorized" with a synthetic category_id so it is
      // never silently dropped and filtering still works.
      const mapped = mapService(s, noProfit);
      orphanServices.push({ ...mapped, category_id: UNCATEGORIZED_ID, source_category_id: s.category_id });
    }
    // else: the category exists but is INACTIVE — the admin hid it,
    // so its services stay hidden with it (never shown, never dropped
    // into Uncategorized).
  }

  const byCat = canonical
    .map((c) => ({ ...c, services: servicesByCat.get(c.id) || [] }))
    .filter((c) => c.services.length > 0);

  // Only add the "Uncategorized" bucket when there are actual
  // orphaned services — an empty bucket is never selectable.
  if (orphanServices.length > 0) {
    byCat.push({
      id: UNCATEGORIZED_ID,
      name: 'Uncategorized',
      slug: 'uncategorized',
      icon: 'package',
      sort: 0,
      active: 1,
      services: orphanServices,
    });
  }

  return res.json({ categories: byCat, no_profit: noProfit, provider_configured: providerConfigured });
});

// GET /api/services/:id
r.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  // LEFT JOIN so an active service whose category row was deleted
  // still resolves (category_name falls back to "Uncategorized")
  // instead of returning a misleading 404.
  const s = db.prepare(
    `SELECT s.*, c.name AS category_name FROM services s
     LEFT JOIN categories c ON c.id = s.category_id WHERE s.id=? AND s.status=1`
  ).get(req.params.id);
  if (!s) return sendErr(res, 404, 'Service not found.');
  const noProfit = req.user.no_profit === 1;
  const rate = noProfit ? s.provider_rate : s.admin_rate;
  return res.json({
    id: s.id,
    category_id: s.category_id,
    provider_service_id: s.provider_service_id,
    category: s.category_name || 'Uncategorized',
    name: s.name,
    description: s.description,
    speed_hint: s.speed_hint,
    type: s.type,
    quality: s.quality,
    min: s.min,
    max: s.max,
    refill: Number(s.refill),
    cancel: Number(s.cancel),
    price_per_1k: displayRatePer1k(rate),
  });
});

export default r;