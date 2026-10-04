import { applyMarkup } from './money.js';

// ---------------------------------------------------------------------------
// Service sync from a provider. This is the ONLY path that populates the
// services table from upstream data; every call is idempotent (the unique
// index idx_services_prov_svc guarantees no duplicate rows).
//
// CATEGORIES: one canonical row per provider category NAME. The slug is
// derived from the normalized name (case + whitespace folded), so every
// service that shares a category name shares ONE category row. The
// upstream "category" field is a label, not a per-service key. (An older
// version derived the slug from the upstream service id, which created
// one category row per service — the "duplicate categories" incident.)
//
// Markup rule (Task 9, strictly enforced):
//   1. If the service row ALREADY EXISTS in the DB → keep the admin-set
//      per-service markup (provider re-syncs never clobber an admin override).
//   2. If the row is NEW → apply the provider markup if set, otherwise the
//      global setting. This is the "per-provider/per-service/global" priority.
//   3. Provider base cost (provider_rate) is ALWAYS refreshed from upstream —
//      the owner must see live supplier pricing.
// ---------------------------------------------------------------------------

/**
 * Canonical display name for a provider category.
 * Trims leading/trailing whitespace and collapses repeated internal
 * whitespace to a single space. The display name itself is preserved
 * verbatim (case is NOT folded here) so the UI stays readable.
 * @param {string} name  raw provider category label
 * @returns {string} normalized display name, e.g. "Instagram Followers"
 */
export function normalizeCategoryName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Case-insensitive comparison key used ONLY to detect duplicate
 * category rows that share the same logical name. Never used as a
 * display value. Null/empty/malformed input folds to '' so it can
 * never collide with a real category.
 * @param {string} name
 * @returns {string} lowercase normalized key
 */
export function categoryNameKey(name) {
  const n = normalizeCategoryName(name);
  return n ? n.toLowerCase() : '';
}

/**
 * Canonical category slug for a provider category name.
 * Case and spacing are formatting noise, but meaningful text —
 * including emoji markers some suppliers use — keeps categories
 * distinct. A deterministic hash of the normalized name prevents
 * long names from colliding after truncation.
 * @param {string} name  raw provider category label
 * @returns {string} slug, e.g. "cat-instagram-followers-9f3ab12c"
 */
export function categoryKey(name) {
  const normKey = normalizeCategoryName(name).toLowerCase() || 'services';
  const slug = normKey
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'services';
  let h = 5381;
  for (let i = 0; i < normKey.length; i++) h = ((h << 5) + h + normKey.charCodeAt(i)) >>> 0;
  return `cat-${slug}-${h.toString(16).padStart(8, '0')}`;
}

/**
 * Resolve a list of category rows to ONE canonical row per logical
 * (normalized-name) category, so duplicate rows that share a name —
 * e.g. a legacy `srvc-*` row and a canonical `cat-*` row — are
 * merged under a single entry and their services are never split
 * across duplicate dropdown labels.
 *
 * Canonical preference within a group: the canonical `cat-*` slug
 * first, then the lowest id (oldest row, so existing service
 * references and ids are preserved). Genuinely different names
 * (different normalized keys) are NEVER merged.
 *
 * @param {Array<{id:number, name:string, slug?:string}>} cats
 * @returns {{ canonical: Array, canonicalOf: Map<number, object> }}
 *   `canonical` — the deduped category list (one per logical name).
 *   `canonicalOf` — maps EVERY original category id -> its canonical row.
 */
export function canonicalizeCategories(cats) {
  const groups = new Map(); // normalized-name key -> [category rows]
  for (const c of cats) {
    const key = categoryNameKey(c.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const canonicalOf = new Map();
  const canonical = [];
  for (const group of groups.values()) {
    const winner = group.slice().sort((a, b) => {
      const ac = String(a.slug || '').startsWith('cat-') ? 0 : 1;
      const bc = String(b.slug || '').startsWith('cat-') ? 0 : 1;
      if (ac !== bc) return ac - bc; // canonical cat-* slug wins
      return (a.id ?? 0) - (b.id ?? 0); // then oldest row
    })[0];
    canonical.push(winner);
    for (const c of group) canonicalOf.set(c.id, winner);
  }
  return { canonical, canonicalOf };
}

/**
 * Pure helper: pick the markup to use for a brand-new service.
 * @param {{markup_type, markup_value}} provider  provider row
 * @param {{type, value}} globalMarkup            global settings
 * @returns {{type, value}}
 */
export function markupFor(provider, globalMarkup) {
  if (provider.markup_type && Number(provider.markup_value) > 0) {
    return { type: provider.markup_type, value: Number(provider.markup_value) };
  }
  return { type: globalMarkup?.type || 'percent', value: Number(globalMarkup?.value ?? 25) };
}

/**
 * Upsert a batch of services from a provider into the catalog.
 * @returns {{pulled: number, added: number, updated: number, skipped: number}}
 */
export function syncProviderServices(db, { provider, list, globalMarkup }) {
  const catSql = 'INSERT INTO categories (name, slug, icon, sort, active) VALUES (?,?,?,0,1) ON CONFLICT(slug) DO NOTHING';
  const catGet = db.prepare('SELECT id FROM categories WHERE slug=?');
  const existing = db.prepare(
    'SELECT provider_service_id, id, markup_type, markup_value, admin_rate FROM services WHERE provider_id=?'
  ).all(provider.id);
  const existsMap = new Map(existing.map((s) => [s.provider_service_id, s]));
  const upsertNew = db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, description, speed_hint,
       type, min, max, provider_rate, admin_rate, markup_type, markup_value, refill, cancel, status, quality, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(provider_id, provider_service_id) DO UPDATE SET
        category_id=excluded.category_id,
        provider_rate=excluded.provider_rate, min=excluded.min, max=excluded.max,
       name=excluded.name, description=excluded.description, type=excluded.type,
       refill=excluded.refill, cancel=excluded.cancel,
       speed_hint=excluded.speed_hint, quality=excluded.quality`
  );
  const now = Date.now();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of list) {
    // Defensive: a provider entry without a service id, a name or a
    // numeric rate is malformed upstream data — skip it rather than
    // create a junk row (or wipe a good one) in the catalog.
    const serviceId = String(s?.service ?? '').trim();
    const name = String(s?.name ?? '').trim();
    const rate = Number(s?.rate);
    if (!serviceId || !name || !Number.isFinite(rate) || rate < 0) { skipped++; continue; }

    // Canonical category: the slug is derived from the provider's
    // category NAME (normalized), so every service that shares a
    // category name shares ONE category row — never one category
    // per service.
    const categoryName = String(s.category ?? '').trim() || 'Services';
    const slug = categoryKey(categoryName);
    db.prepare(catSql).run(categoryName, slug, 'package');
    const catRow = catGet.get(slug);
    if (!catRow) { skipped++; continue; }
    const catId = catRow.id;

    const min = Math.floor(Number(s.min));
    const max = Math.floor(Number(s.max));
    const exists = existsMap.get(serviceId);
    if (!exists) added++; else updated++;
    const fresh = markupFor(provider, globalMarkup);
    const adminRate = exists
      ? exists.admin_rate                       // preserve admin override
      : applyMarkup(rate, fresh.type, fresh.value);
    // Average completion time → speed_hint (display field).
    const speedHint = s.avg ?? s.speed ?? null;
    const quality = s.quality ?? null;
    upsertNew.run(
      catId, provider.id, serviceId, name,
      s.description ?? null,
      speedHint === undefined || speedHint === null ? null : String(speedHint).slice(0, 80),
      s.type || 'Default',
      Number.isFinite(min) && min >= 0 ? min : 1,
      Number.isFinite(max) && max > 0 ? max : 999999,
      rate, adminRate,
      exists ? exists.markup_type : fresh.type,
      exists ? exists.markup_value : fresh.value,
      Number(s.refill === true || s.refill === 1 || s.refill === '1' || s.refill === 'true'),
      Number(s.cancel === true || s.cancel === 1 || s.cancel === '1' || s.cancel === 'true'),
      quality === undefined || quality === null ? null : String(quality).slice(0, 80),
      now
    );
  }
  return { pulled: list.length, added, updated, skipped };
}