import { getDb } from '../db.js';

// ---------------------------------------------------------------------------
// Provider adapter registry. Each adapter implements:
//   init()                                  — called once at provider creation
//   listServices()                          → [{service, name, rate, min, max, category, description}]
//   placeOrder({service, link, quantity})   → {id, status}
//   orderStatus(id)                         → {status, startCount, remains}
//   balance()                               → number
//   cancel(id) / refill(id)                 → optional
// All provider api_url/api_key live server-side (env / providers table) and
// are passed into the adapter factory — never serialized to clients.
// ---------------------------------------------------------------------------

const registry = new Map();

export function registerProviderAdapter(name, factory) {
  registry.set(name, factory);
}

export function createAdapter(name, providerRow) {
  const factory = registry.get(name);
  if (!factory) throw new Error(`Unknown adapter: ${name}`);
  return factory(providerRow);
}

// Fetch a fully-masked provider row: no api_key / api_url leak.
// Safe operational fields (connection status, last success/error, markup,
// currency, balance) ARE exposed — they are the admin's monitoring surface.
export function maskedProvider(row) {
  if (!row) return null;
  const { api_key, api_url, ...safe } = row;
  return {
    ...safe,
    has_api_key: Boolean(api_key),
    api_url_masked: api_url ? `${String(api_url).slice(0, 8)}…` : null,
    service_count: getDb().prepare('SELECT COUNT(*) c FROM services WHERE provider_id=?').get(row.id).c,
    base: undefined, // safety: a stray key named base is never serialized
  };
}

export function providerRow(db, id) {
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id);
}