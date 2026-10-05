import { getDb } from '../db.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Environment-managed SMM supplier bootstrap (THEMAINSMMPROVIDER_*).
//
// When BOTH THEMAINSMMPROVIDER_API_URL and THEMAINSMMPROVIDER_API_KEY are
// non-empty, the server boot ensures a matching provider row exists so the
// supplier configuration survives restarts and redeployments WITHOUT manual
// re-entry in Admin → Providers.
//
// The bootstrap performs NO network calls and places NO orders. The service
// catalog is still pulled only through the existing runtime mechanism
// (Admin → Providers → Sync Services), and a configured provider is never
// auto-verified or auto-activated — it simply becomes available for the
// admin to sync and for orders to route to once services exist.
//
// Precedence (documented in README.md → "Environment-managed configuration"):
//   • Valid environment configuration is the authoritative default for the
//     DESIGNATED provider — the row flagged env_managed=1, identified by its
//     API URL. At every boot its api_url/api_key are brought in line with
//     the environment.
//   • Admin panel edits (name, markup, currency, active — and credentials)
//     apply at runtime and hold until the next restart, when the environment
//     values re-apply. To run on panel-only credentials permanently, unset
//     the environment variables: the bootstrap then never runs and the
//     stored configuration is authoritative.
//   • Admin-created providers (any other API URL) are NEVER touched.
//   • Blank/absent variables are a complete no-op — an empty value can
//     never erase or alter a valid stored configuration.
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_NAME = 'MainSMM Provider';

// A managed URL must be a well-formed https URL. Never log the value.
function validManagedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

// Optional `overrides` exists for isolated testing; the production caller
// (server/index.js) passes nothing and uses the values captured in config.
export function bootstrapManagedProvider(overrides) {
  const { apiUrl, apiKey } = overrides || config.managedProvider;

  // Incomplete environment configuration — do nothing at all.
  if (!apiUrl || !apiKey) {
    return { status: 'skipped', reason: 'incomplete-env' };
  }

  if (!validManagedUrl(apiUrl)) {
    return {
      status: 'error',
      // Deliberately contains no credential values and does not echo the
      // invalid input back.
      message: 'Invalid THEMAINSMMPROVIDER_API_URL (a full https:// URL is required). The environment-managed provider was NOT configured.',
    };
  }

  const db = getDb();
  const now = Date.now();

  // 1) The designated row (flagged by a previous boot). Bring its credentials
  //    in line with the environment; every other column (name, markup,
  //    currency, active …) keeps the admin-set value.
  const managed = db.prepare('SELECT * FROM providers WHERE env_managed=1').get();
  if (managed) {
    const changed = managed.api_url !== apiUrl || managed.api_key !== apiKey;
    if (changed) {
      db.prepare('UPDATE providers SET api_url=?, api_key=?, updated_at=? WHERE id=?')
        .run(apiUrl, apiKey, now, managed.id);
    }
    return { status: 'updated', id: managed.id, changed };
  }

  // 2) No flagged row — adopt a stored provider that already uses this API
  //    URL (the environment designates THE provider for that endpoint). This
  //    also recovers the flag after a schema migration and prevents duplicate
  //    providers across restarts and redeployments.
  const sameUrl = db.prepare('SELECT * FROM providers WHERE api_url=?').get(apiUrl);
  if (sameUrl) {
    db.prepare('UPDATE providers SET api_key=?, env_managed=1, updated_at=? WHERE id=?')
      .run(apiKey, now, sameUrl.id);
    return { status: 'adopted', id: sameUrl.id, changed: true };
  }

  // 3) Nothing exists yet — create the designated provider with the schema's
  //    defaults (smmpost adapter, USD, 25% percent markup, active). It is
  //    NOT auto-synced and NOT auto-verified: the catalog is pulled only via
  //    Admin → Providers → Sync Services, and no order is ever placed here.
  const info = db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, env_managed, active, currency,
       markup_type, markup_value, created_at, updated_at)
     VALUES (?, 'smmpost', ?, ?, 1, 1, 'USD', 'percent', 25, ?, ?)`
  ).run(DEFAULT_PROVIDER_NAME, apiUrl, apiKey, now, now);
  return { status: 'created', id: Number(info.lastInsertRowid) };
}
