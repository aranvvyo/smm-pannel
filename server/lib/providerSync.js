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

    const slug = 'srvc-' + serviceId.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    db.prepare(catSql).run(s.category || 'Services', slug, 'package');
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