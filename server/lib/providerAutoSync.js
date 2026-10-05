import { getDb, getSetting } from '../db.js';
import { createAdapter } from './provider.js';
import { syncProviderServices } from './providerSync.js';

// ---------------------------------------------------------------------------
// AUTOMATIC service-catalog synchronization for the configured provider(s).
//
// Complements lib/managedProvider.js (which only creates/updates the
// env-managed PROVIDER ROW from THEMAINSMMPROVIDER_* without any network
// call). This module keeps the SERVICE CATALOG accurate: at boot (deferred,
// so an upstream outage can never delay or break startup) and then on a
// fixed interval, every ACTIVE real provider with credentials is synced via
// the SAME code path the admin uses (Admin → Providers → Sync Services —
// lib/providerSync.js), which:
//   • preserves admin-set per-service markup / selling rates on every
//     existing service (an override is NEVER overwritten),
//   • refreshes provider base costs, names, categories, min/max, type,
//     refill/cancel, quality and average time from upstream,
//   • upserts idempotently (unique index idx_services_prov_svc).
//
// Safety contract:
//   • read-only upstream calls only (action=services) — an order is NEVER
//     placed here,
//   • no secrets in logs: only the provider id/name and error message
//     (the adapter already redacts the key from upstream error text),
//   • one sync at a time (a re-entrant call returns 'busy' instead of
//     stacking concurrent runs),
//   • every failure is caught and recorded in providers.last_error — the
//     server keeps running and the next interval retries,
//   • providers WITHOUT credentials, INACTIVE providers and the test-only
//     'demo' adapter are skipped — nothing is invented and, in particular,
//     no network call happens for a demo/test provider.
//
// Configuration (environment, all optional):
//   PROVIDER_AUTO_SYNC=0            → disable entirely (default: enabled)
//   PROVIDER_SYNC_INTERVAL_HOURS=n  → periodic re-sync interval
//                                     (default 6, clamped to 1…168; the
//                                     boot sync always runs once)
// ---------------------------------------------------------------------------

const DISABLED = String(process.env.PROVIDER_AUTO_SYNC || '').trim() === '0';
const INTERVAL_HOURS = Math.min(168, Math.max(1, Number(process.env.PROVIDER_SYNC_INTERVAL_HOURS) || 6));
const BOOT_DELAY_MS = 5000; // let the HTTP listener come up first

let syncing = false;
let timer = null;

// One guarded sync pass over every eligible provider. Never throws.
export async function autoSyncProviderServices() {
  if (DISABLED) return { status: 'disabled' };
  if (syncing) return { status: 'busy' };
  syncing = true;
  try {
    const db = getDb();
    const globalMarkup = {
      type: getSetting('global_markup_type') || 'percent',
      value: Number(getSetting('global_markup_value') ?? 25),
    };
    const rows = db.prepare('SELECT * FROM providers WHERE active=1 ORDER BY id').all();
    const results = [];
    for (const p of rows) {
      // Skip everything that must never produce a network call or a
      // fabricated catalog: the test-only demo adapter and providers whose
      // credentials are not (yet) configured.
      if (p.adapter === 'demo') continue;
      if (!p.api_url || !p.api_key) continue;
      const now = Date.now();
      let list;
      try {
        list = await createAdapter(p.adapter, p).listServices();
      } catch (e) {
        // Upstream down / bad credentials / invalid response — record and
        // continue. The catalog keeps its last known state; the next
        // interval retries. The message is already key-redacted.
        db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
          .run(String('Auto-sync failed: ' + (e?.message || e)).slice(0, 300), now, p.id);
        results.push({ id: p.id, name: p.name, status: 'error' });
        continue;
      }
      if (!Array.isArray(list) || list.length === 0) {
        db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
          .run('Auto-sync failed: provider returned no services', now, p.id);
        results.push({ id: p.id, name: p.name, status: 'empty' });
        continue;
      }
      let out;
      try {
        out = syncProviderServices(db, { provider: p, list, globalMarkup });
      } catch (e) {
        db.prepare('UPDATE providers SET last_error=?, updated_at=? WHERE id=?')
          .run(String('Auto-sync failed: ' + (e?.message || e)).slice(0, 300), now, p.id);
        results.push({ id: p.id, name: p.name, status: 'error' });
        continue;
      }
      db.prepare('UPDATE providers SET last_sync_at=?, last_success_at=?, last_error=NULL, updated_at=? WHERE id=?')
        .run(now, now, now, p.id);
      results.push({ id: p.id, name: p.name, status: 'synced', ...out });
    }
    return { status: 'ok', providers: results };
  } catch (e) {
    // Absolutely never break the server over a sync problem.
    console.warn('[instasmm] provider auto-sync error:', e?.message || e);
    return { status: 'error', message: String(e?.message || e) };
  } finally {
    syncing = false;
  }
}

// Boot + interval scheduling. Deferred and unref'd: the boot sync never
// delays startup, never blocks process exit, and an upstream outage can
// never prevent the server from starting or serving requests.
export function startProviderAutoSync() {
  if (DISABLED) {
    console.log('[instasmm] provider auto-sync disabled (PROVIDER_AUTO_SYNC=0)');
    return;
  }
  const run = () => {
    Promise.resolve(autoSyncProviderServices())
      .then((r) => {
        if (r?.status === 'ok') {
          for (const p of r.providers || []) {
            if (p.status === 'synced') {
              console.log(`[instasmm] auto-sync "${p.name}": +${p.added} new, ${p.updated} updated, ${p.skipped} skipped`);
            } else if (p.status === 'error') {
              console.warn(`[instasmm] auto-sync "${p.name}" failed — recorded in providers.last_error`);
            }
          }
        }
      })
      .catch(() => { /* unreachable — autoSync never rejects */ });
  };
  const boot = setTimeout(run, BOOT_DELAY_MS);
  boot.unref();
  timer = setInterval(run, INTERVAL_HOURS * 3600 * 1000);
  timer.unref();
  console.log(`[instasmm] provider auto-sync active (boot + every ${INTERVAL_HOURS}h)`);
}

// Test hook — stop the interval without touching production state.
export function stopProviderAutoSync() {
  if (timer) { clearInterval(timer); timer = null; }
}
