import { applyMarkup } from './money.js';

// ---------------------------------------------------------------------------
// Service sync from a provider. This is the ONLY path that populates the
// services table from upstream data; every call is idempotent (the unique
// index idx_services_prov_svc guarantees no duplicate rows).
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
 * @returns {{pulled: number, added: number, updated: number}}
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
       type, min, max, provider_rate, admin_rate, markup_type, markup_value, refill, cancel, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(provider_id, provider_service_id) DO UPDATE SET
       provider_rate=excluded.provider_rate, min=excluded.min, max=excluded.max,
       name=excluded.name, description=excluded.description, type=excluded.type,
       refill=excluded.refill, cancel=excluded.cancel`
  );
  const now = Date.now();
  let added = 0;
  let updated = 0;

  for (const s of list) {
    const slug = 'srvc-' + String(s.service).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    db.prepare(catSql).run(s.category || 'Services', slug, 'package');
    const catId = catGet.get(slug).id;
    const rate = Number(s.rate) || 0;
    const exists = existsMap.get(String(s.service));
    if (!exists) added++; else updated++;
    const fresh = markupFor(provider, globalMarkup);
    const adminRate = exists
      ? exists.admin_rate                       // preserve admin override
      : applyMarkup(rate, fresh.type, fresh.value);
    upsertNew.run(
      catId, provider.id, String(s.service), s.name, s.description, null,
      s.type || 'Default', s.min, s.max, rate, adminRate,
      exists ? exists.markup_type : fresh.type,
      exists ? exists.markup_value : fresh.value,
      s.refill ?? 0, s.cancel ?? 0, now
    );
  }
  return { pulled: list.length, added, updated };
}