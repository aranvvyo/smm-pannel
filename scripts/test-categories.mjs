// ---------------------------------------------------------------------------
// Category regression tests — the "duplicate categories" incident:
//   C1  normalization (trim / collapse whitespace) is correct
//   C2  case/whitespace-only variants of one name merge to ONE category
//   C3  genuinely different names (incl. emoji markers) stay separate
//   C4  the client catalog never shows a category twice and never splits a
//       category's services across duplicate labels
//   C5  a service stored under a duplicate row is presented under the
//       CANONICAL category id (so the client filter still matches)
//   C6  a service whose category row was DELETED is grouped under
//       "Uncategorized" (never silently dropped)
//   C7  a service whose category is INACTIVE stays hidden with it
//   C8  repeated provider syncs create no duplicate category rows
//   C9  the admin create/update forms reject a missing category_id and the
//       create-form dropdown carries no duplicate names
//
// Usage: node scripts/test-categories.mjs
//
// Runs against a THROWAWAY SQLite database (DB_FILE is honored at import
// time, so it is set before any server module loads). No network calls.
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// --- environment BEFORE any server module is imported (config.js reads it)
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'instasmm-cats-'));
process.env.SMM_TEST = '1';
process.env.DB_FILE = path.join(TEST_DIR, 'cats.db');
process.env.ADMIN_EMAIL_1 = 'cats-admin@test.dev';
process.env.ADMIN_PASSWORD_1 = 'cats-admin-pass-123';
process.env.SESSION_SECRET = 'cats-session-secret';
process.env.DEMO_SPEED = '1000';

// always clean up our own throwaway test database
process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { getDb } = await import('../server/db.js');
const {
  normalizeCategoryName, categoryNameKey, categoryKey,
  canonicalizeCategories, syncProviderServices,
} = await import('../server/lib/providerSync.js');
const { applyMarkup } = await import('../server/lib/money.js');
const { hashPassword } = await import('../server/lib/passwords.js');
const clientServicesRouter = (await import('../server/routes/client.services.js')).default;
const adminServicesRouter = (await import('../server/routes/admin.services.js')).default;

const db = getDb();

// ---------------------------------------------------------------------------
// Tiny harness (mirrors scripts/test-regressions.mjs)
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e && e.message ? e.message : String(e)}`);
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type() { return this; },
    cookie() { return this; },
    clearCookie() { return this; },
  };
  return res;
}

async function call(router, { method = 'GET', url = '/', body = undefined, cookies = {}, query = {}, headers = {} } = {}) {
  const req = { method, url, query, body, cookies, headers, ip: '127.0.0.1', user: null };
  const res = makeRes();
  let nextErr = null;
  await router(req, res, (e) => { nextErr = e || null; });
  if (nextErr) throw nextErr;
  return res;
}

function makeSession(userId) {
  const token = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, ip, expires_at, created_at) VALUES (?,?,?,?,?)'
  ).run(createHash('sha256').update(token).digest('hex'), userId, '127.0.0.1',
    Date.now() + 86_400_000, Date.now());
  return { instasmm_session: token };
}

function createUser(email, balancePaise) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?, 'client', 'Cats', ?, 0, 'active', 0, ?)`
  ).run(email, hashPassword('cats-pass-1'), balancePaise, now);
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

function createProvider(name) {
  const now = Date.now();
  const id = db.prepare(
    `INSERT INTO providers (name, adapter, api_url, api_key, active, currency, markup_type, markup_value, created_at, updated_at)
     VALUES (?, 'smmpost', 'https://api.example.com/smm', 'sk-cats-1', 1, 'USD', 'percent', 25, ?, ?)`
  ).run(name, now, now).lastInsertRowid;
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id);
}

function createCategory(name, slug, active = 1) {
  db.prepare(
    'INSERT INTO categories (name, slug, icon, sort, active) VALUES (?,?,?,0,?)'
  ).run(name, slug, 'package', active);
  return db.prepare('SELECT * FROM categories WHERE slug=?').get(slug);
}

function createService({ categoryId, providerId, serviceId, name, rate = 5 }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate,
       min, max, status, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`
  ).run(categoryId, providerId, serviceId, name, rate, applyMarkup(rate, 'percent', 25), 10, 1000, now);
  return db.prepare('SELECT * FROM services WHERE provider_service_id=?').get(serviceId);
}

// A service whose category row was DELETED (dangling category_id)
// cannot be created by any legitimate write: the schema declares
// services.category_id NOT NULL REFERENCES categories(id) ON DELETE
// CASCADE, so the FK rejects a dangling id and deleting a category
// removes its services. In production this state exists only in
// LEGACY databases created before the constraint — exactly what the
// "Uncategorized" handling in client.services.js defends against.
// Simulate that legacy state on the throwaway test DB:
// PRAGMA foreign_keys is a per-connection setting (NOT stored in the
// DB file; fresh connections default to OFF), so a second connection
// inserts the orphan row while the main connection — the one the
// server routes under test use — keeps full FK enforcement. No
// production or test-suite FK enforcement is weakened or disabled.
function createLegacyOrphanService({ categoryId, providerId, serviceId, name, rate = 5 }) {
  const legacy = new DatabaseSync(process.env.DB_FILE);
  try {
    legacy.exec('PRAGMA foreign_keys = OFF');
    legacy.prepare(
      `INSERT INTO services (category_id, provider_id, provider_service_id, name, provider_rate, admin_rate,
         min, max, status, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`
    ).run(categoryId, providerId, serviceId, name, rate, applyMarkup(rate, 'percent', 25), 10, 1000, Date.now());
  } finally {
    legacy.close();
  }
  return db.prepare('SELECT * FROM services WHERE provider_service_id=?').get(serviceId);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = 'cats-admin@test.dev';
const adminUser = db.prepare('SELECT * FROM users WHERE email=?').get(ADMIN_EMAIL);
assert.ok(adminUser && adminUser.role === 'admin', 'admin seed missing');
const adminCookies = makeSession(adminUser.id);

const provider = createProvider('Cats Provider');
const clientUser = createUser('cats-client@test.dev', 1000);
const clientCookies = makeSession(clientUser.id);

console.log('C1 — normalization');

await t('normalizeCategoryName trims and collapses internal whitespace, preserving case', () => {
  assert.strictEqual(normalizeCategoryName('  Instagram   Followers '), 'Instagram Followers');
  assert.strictEqual(normalizeCategoryName('Telegram\tMembers'), 'Telegram Members');
  assert.strictEqual(normalizeCategoryName('TikTok'), 'TikTok');
  assert.strictEqual(normalizeCategoryName(null), '');
  assert.strictEqual(normalizeCategoryName(undefined), '');
  assert.strictEqual(normalizeCategoryName('   '), '');
});

await t('categoryNameKey folds case for comparison and is never a display value', () => {
  assert.strictEqual(categoryNameKey('Instagram Followers'), 'instagram followers');
  assert.strictEqual(categoryNameKey('  INSTAGRAM   followers '), 'instagram followers');
  assert.strictEqual(categoryNameKey(''), '');
  assert.strictEqual(categoryNameKey(null), '');
});

console.log('C2/C3 — canonicalization');

await t('canonicalizeCategories merges case/whitespace-only variants into ONE canonical row', () => {
  const a = { id: 1, name: 'Instagram Followers', slug: 'cat-instagram-followers-1' };
  const b = { id: 2, name: '  instagram   followers ', slug: 'srvc-legacy-2' };
  const c = { id: 3, name: 'INSTAGRAM FOLLOWERS', slug: 'srvc-legacy-3' };
  const { canonical, canonicalOf } = canonicalizeCategories([a, b, c]);
  assert.strictEqual(canonical.length, 1, 'three name-variants must merge to one category');
  // canonical preference: the cat-* slug wins, then the lowest id
  assert.strictEqual(canonical[0].id, 1, 'the canonical cat-* slug must win');
  assert.strictEqual(canonicalOf.get(1).id, 1);
  assert.strictEqual(canonicalOf.get(2).id, 1, 'the legacy row maps to the canonical row');
  assert.strictEqual(canonicalOf.get(3).id, 1);
});

await t('canonicalizeCategories keeps genuinely different names separate', () => {
  const a = { id: 1, name: 'YouTube Subscribers', slug: 'cat-yt-sub-1' };
  const b = { id: 2, name: 'YouTube Views', slug: 'cat-yt-view-2' };
  const c = { id: 3, name: 'YouTube Subscribers 🔥', slug: 'cat-yt-fire-3' };
  const { canonical } = canonicalizeCategories([a, b, c]);
  assert.strictEqual(canonical.length, 3, 'distinct names (incl. emoji) must stay separate');
});

await t('canonicalizeCategories prefers the lowest id when no cat-* slug is present', () => {
  const a = { id: 7, name: 'Telegram Members', slug: 'srvc-7' };
  const b = { id: 4, name: 'Telegram Members', slug: 'srvc-4' };
  const { canonical } = canonicalizeCategories([a, b]);
  assert.strictEqual(canonical.length, 1);
  assert.strictEqual(canonical[0].id, 4, 'with no canonical slug the oldest row wins');
});

console.log('C4/C5 — client catalog');

await t('GET /api/services: duplicate category rows appear ONCE with their services merged', async () => {
  // One logical category stored as a canonical row + a legacy duplicate row.
  const canon = createCategory('Instagram Followers', categoryKey('Instagram Followers'));
  const legacy = createCategory('instagram followers', 'srvc-legacy-followers');
  createService({ categoryId: canon.id, providerId: provider.id, serviceId: 'c1', name: 'Canon Svc', rate: 8 });
  createService({ categoryId: legacy.id, providerId: provider.id, serviceId: 'c2', name: 'Legacy Svc', rate: 9 });

  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const matches = r.body.categories.filter((c) => categoryNameKey(c.name) === 'instagram followers');
  assert.strictEqual(matches.length, 1, 'the duplicate category must be merged into one entry');
  const cat = matches[0];
  assert.strictEqual(cat.id, canon.id, 'the canonical row id must be used');
  assert.strictEqual(cat.services.length, 2, 'both services must be merged under the canonical category');
  const names = cat.services.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['Canon Svc', 'Legacy Svc']);
  // Every service carries the CANONICAL category id (the client filter invariant).
  for (const s of cat.services) {
    assert.strictEqual(s.category_id, canon.id, `service ${s.name} must carry the canonical category_id`);
  }
});

await t('GET /api/services: an empty category is not listed and never leaks another category services', async () => {
  createCategory('Empty Category', 'cat-empty-category'); // no services
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!r.body.categories.some((c) => c.name === 'Empty Category'),
    'a category with no services must not be listed');
  // Cross-category isolation: no service appears under a category it does not belong to.
  for (const c of r.body.categories) {
    for (const s of c.services) {
      assert.strictEqual(s.category_id, c.id, `service ${s.name} must belong to its own category`);
    }
  }
});

await t('GET /api/services: distinct categories are listed separately with only their own services', async () => {
  const alpha = createCategory('Alpha Services', categoryKey('Alpha Services'));
  const beta = createCategory('Beta Services', categoryKey('Beta Services'));
  createService({ categoryId: alpha.id, providerId: provider.id, serviceId: 'a1', name: 'Alpha One', rate: 8 });
  createService({ categoryId: alpha.id, providerId: provider.id, serviceId: 'a2', name: 'Alpha Two', rate: 9 });
  createService({ categoryId: beta.id, providerId: provider.id, serviceId: 'b1', name: 'Beta One', rate: 7 });

  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  const byName = new Map(r.body.categories.map((c) => [c.name, c]));
  assert.strictEqual(byName.get('Alpha Services').services.length, 2);
  assert.strictEqual(byName.get('Beta Services').services.length, 1);
  assert.ok(byName.get('Alpha Services').services.every((s) => s.name.startsWith('Alpha')));
  assert.ok(byName.get('Beta Services').services.every((s) => s.name.startsWith('Beta')));
});

await t('GET /api/services never leaks provider_rate / admin_rate / markup to clients', async () => {
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  for (const c of r.body.categories) {
    for (const s of c.services) {
      for (const k of ['provider_rate', 'admin_rate', 'markup_type', 'markup_value', 'base_cost_inr']) {
        assert.ok(!(k in s), `${k} must never be exposed to clients`);
      }
    }
  }
});

console.log('C6/C7 — orphaned and inactive categories');

await t('GET /api/services: a service whose category row was DELETED is grouped under Uncategorized', async () => {
  // A dangling category_id is impossible through any legitimate write
  // (FK + NOT NULL + ON DELETE CASCADE) — it exists only in legacy
  // databases that predate the constraint, which is exactly the state
  // the route's "Uncategorized" handling defends against. Seed it as
  // legacy data (see createLegacyOrphanService).
  const orphan = createLegacyOrphanService({ categoryId: 999999, providerId: provider.id, serviceId: 'orphan-1', name: 'Orphan Svc', rate: 6 });
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  const uncat = r.body.categories.find((c) => c.id === 0 || c.name === 'Uncategorized');
  assert.ok(uncat, 'an Uncategorized bucket must appear when a service has no category');
  const found = uncat.services.find((s) => s.id === orphan.id);
  assert.ok(found, 'the orphaned service must not be silently dropped');
  assert.strictEqual(found.category_id, 0, 'the orphan carries the synthetic Uncategorized id');
  assert.strictEqual(found.source_category_id, 999999, 'the original category id is preserved for diagnostics');
});

await t('GET /api/services: a service whose category is INACTIVE stays hidden with it', async () => {
  const hidden = createCategory('Hidden Category', 'cat-hidden-category', 0); // active=0
  createService({ categoryId: hidden.id, providerId: provider.id, serviceId: 'hidden-1', name: 'Hidden Svc', rate: 6 });
  const r = await call(clientServicesRouter, { method: 'GET', url: '/', cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  // The service must not appear anywhere — not under its category nor under Uncategorized.
  const all = r.body.categories.flatMap((c) => c.services);
  assert.ok(!all.some((s) => s.name === 'Hidden Svc'),
    'a service in an inactive category must stay hidden (not moved to Uncategorized)');
  assert.ok(!r.body.categories.some((c) => c.name === 'Hidden Category'),
    'an inactive category must not be listed');
});

await t('GET /api/services/:id resolves an orphaned service with category "Uncategorized"', async () => {
  const orphan = db.prepare(
    "SELECT * FROM services WHERE provider_service_id='orphan-1'"
  ).get();
  const r = await call(clientServicesRouter, { method: 'GET', url: `/${orphan.id}`, cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.category, 'Uncategorized', 'a deleted category must read as Uncategorized');
});

await t('GET /api/services/:id resolves a normal service with its real category name', async () => {
  const svc = db.prepare(
    "SELECT * FROM services WHERE provider_service_id='a1'"
  ).get();
  const r = await call(clientServicesRouter, { method: 'GET', url: `/${svc.id}`, cookies: clientCookies });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.category, 'Alpha Services');
});

console.log('C8 — idempotent sync');

await t('repeated provider syncs create no duplicate category rows', async () => {
  const list = [
    { service: 'd1', name: 'Dup One', category: 'Dedup Category', rate: 5, min: 10, max: 1000 },
    { service: 'd2', name: 'Dup Two', category: 'Dedup Category', rate: 6, min: 10, max: 1000 },
  ];
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  syncProviderServices(db, { provider, list, globalMarkup: { type: 'percent', value: 25 } });
  const rows = db.prepare('SELECT * FROM categories WHERE slug=?').all(categoryKey('Dedup Category'));
  assert.strictEqual(rows.length, 1, 'three syncs of the same category must yield ONE category row');
  const svcCount = db.prepare('SELECT COUNT(*) c FROM services WHERE category_id=?').get(rows[0].id).c;
  assert.strictEqual(svcCount, 2, 'both services must point at the single category row');
});

console.log('C9 — admin form validation');

await t('GET /api/admin/services: the create-form dropdown carries no duplicate category names', async () => {
  // A canonical row + a legacy duplicate that both have services.
  const canon = db.prepare("SELECT id FROM categories WHERE slug=?").get(categoryKey('Instagram Followers'));
  createService({ categoryId: canon.id, providerId: provider.id, serviceId: 'adm-1', name: 'Admin Svc', rate: 8 });
  const r = await call(adminServicesRouter, { method: 'GET', url: '/', cookies: adminCookies });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const names = r.body.categories.map((c) => categoryNameKey(c.name));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.strictEqual(dupes.length, 0, `the dropdown must not contain duplicate category names: ${JSON.stringify(names)}`);
  // Every listed category actually has at least one service.
  for (const c of r.body.categories) {
    const n = db.prepare('SELECT COUNT(*) c FROM services WHERE category_id=?').get(c.id).c;
    assert.ok(n > 0, `category ${c.name} must have services to appear in the dropdown`);
  }
});

await t('PATCH /api/admin/services/:id rejects a reassignment to a missing category_id (400)', async () => {
  const svc = createService({ categoryId: db.prepare("SELECT id FROM categories WHERE slug=?").get(categoryKey('Alpha Services')).id, providerId: provider.id, serviceId: 'patch-1', name: 'Patch Svc', rate: 5 });
  const r = await call(adminServicesRouter, {
    method: 'PATCH', url: `/${svc.id}`,
    body: { category_id: 999999 },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${JSON.stringify(r.body)}`);
  // The service must be untouched.
  const after = db.prepare('SELECT category_id FROM services WHERE id=?').get(svc.id);
  assert.notStrictEqual(after.category_id, 999999, 'a rejected category_id must not be written');
});

await t('PATCH /api/admin/services/:id accepts a reassignment to an existing category_id', async () => {
  const beta = db.prepare("SELECT id FROM categories WHERE slug=?").get(categoryKey('Beta Services'));
  const svc = createService({ categoryId: db.prepare("SELECT id FROM categories WHERE slug=?").get(categoryKey('Alpha Services')).id, providerId: provider.id, serviceId: 'patch-2', name: 'Patch Svc 2', rate: 5 });
  const r = await call(adminServicesRouter, {
    method: 'PATCH', url: `/${svc.id}`,
    body: { category_id: beta.id },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.prepare('SELECT category_id FROM services WHERE id=?').get(svc.id);
  assert.strictEqual(after.category_id, beta.id, 'a valid category_id must be written');
});

await t('POST /api/admin/services rejects a service with a missing category_id (400)', async () => {
  const r = await call(adminServicesRouter, {
    method: 'POST', url: '/',
    body: { name: 'Bad Cat Svc', provider_id: provider.id, category_id: 999999, provider_rate: 5, min: 10, max: 100 },
    cookies: adminCookies,
  });
  assert.strictEqual(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${JSON.stringify(r.body)}`);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM services WHERE name='Bad Cat Svc'").get().c, 0,
    'a service with an invalid category must not be created');
});

// ---------------------------------------------------------------------------
console.log(`\ncategories: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
