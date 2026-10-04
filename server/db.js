import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './lib/passwords.js';

// ---------------------------------------------------------------------------
// Database bootstrap. Uses the built-in node:sqlite (DatabaseSync) so there is
// zero native dependency — installs cleanly anywhere Node 22+ runs.
// ---------------------------------------------------------------------------

let db = null;

export function getDb() {
  if (db) return db;
  mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(path.join(config.rootDir, 'server', 'schema.sql'), 'utf8'));
  ensureColumns();
  ensureDefaults();
  seedIfEmpty();
  cleanupDemoProviders();
  return db;
}

// ---------------------------------------------------------------------------
// Migrations for databases created before the FINAL IMPLEMENTATION PASS.
// Each column is added only if missing, so old .db files upgrade in place.
// ---------------------------------------------------------------------------
function ensureColumns() {
  const have = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, ddl) => { if (!have(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };

  add('providers', 'currency', 'TEXT NOT NULL DEFAULT \'USD\'');
  add('providers', 'markup_type', 'TEXT NOT NULL DEFAULT \'percent\'');
  add('providers', 'markup_value', 'REAL NOT NULL DEFAULT 25');
  add('providers', 'last_sync_at', 'INTEGER');
  add('providers', 'last_success_at', 'INTEGER');
  add('providers', 'last_error', 'TEXT');

  add('services', 'type', 'TEXT');
  add('services', 'refill', 'INTEGER NOT NULL DEFAULT 0');
  add('services', 'cancel', 'INTEGER NOT NULL DEFAULT 0');
  add('services', 'quality', 'TEXT');

  add('orders', 'provider_charge', 'REAL');
  add('orders', 'provider_currency', 'TEXT');
  add('orders', 'provider_meta', 'TEXT');

  add('deposits', 'provider_event', 'TEXT');
  add('deposits', 'confirmed_at', 'INTEGER');

  // Apirone real-payment support: minor units for crypto amounts, currency
  // code as Apirone knows it, and cumulative USD cents credited so far.
  add('deposits', 'amount_minor', 'REAL');
  add('deposits', 'currency_code', 'TEXT');
  add('deposits', 'paid_usd', 'INTEGER NOT NULL DEFAULT 0');
  add('deposits', 'reject_reason', 'TEXT');

  // Verified crypto receipt for honest display: the actual minor units seen
  // on-chain and the last real transaction id (never fabricated).
  add('deposits', 'received_minor', 'REAL');
  add('deposits', 'tx_hash', 'TEXT');

  // Unique constraint: provider order id accepted exactly once (idempotent placement).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_prov_order ON orders(provider_id, provider_order_id) WHERE provider_order_id IS NOT NULL');

  // Withdrawals: real on-chain hash reported by the gateway (never fabricated).
  add('withdrawals', 'tx_hash', 'TEXT');

  // Security-log detail column (see middleware/auth.js logSecurity):
  // optional audit context — the stated reason, deposit references,
  // amounts — for events that require one. Additive only; existing
  // rows keep NULL and every pre-existing caller is unaffected.
  add('security_logs', 'detail', 'TEXT');
}

// Ensure every defaultSetting key exists in the settings table (never drops
// admin-tweaked values).
function ensureDefaults() {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(config.defaultSettings)) ins.run(k, String(v));
}

export function newId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now().toString(36).slice(-4).toUpperCase();
}

// ---------------------------------------------------------------------------
// In production (non-SMM_TEST), remove legacy demo provider and its services.
// Orders keep immutable history; provider_id on old orders is set to NULL.
// ---------------------------------------------------------------------------
function cleanupDemoProviders() {
  if (process.env.SMM_TEST === '1') return;
  const demo = db.prepare("SELECT id FROM providers WHERE adapter='demo'").all();
  if (demo.length === 0) return;
  console.log('[instasmm] Cleaning up legacy demo provider(s) in production…');
  // orders.service_id must be detachable (NULL) for history preservation —
  // a database created by an older schema still declares it NOT NULL, which
  // would make the detach UPDATE fail and abort the whole cleanup. Rebuild
  // the table once (only when needed) so the cleanup can proceed.
  ensureServiceIdNullable();
  const ids = demo.map((d) => d.id);
  const placeholders = ids.map(() => '?').join(',');
  try {
    // Detach order history FIRST: orders keep immutable history, but
    // the service rows they reference are removed below (foreign keys
    // are enforced, so deleting referenced rows would otherwise crash
    // the boot). Detached orders render with a blank service name.
    db.prepare(
      `UPDATE orders SET provider_id=NULL, service_id=NULL
       WHERE provider_id IN (${placeholders})
          OR service_id IN (SELECT id FROM services WHERE provider_id IN (${placeholders}))`
    ).run(...ids, ...ids);
    db.prepare(`DELETE FROM services WHERE provider_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM providers WHERE adapter='demo'`).run();
  } catch (e) {
    console.warn('[instasmm] Legacy demo-provider cleanup could not complete — resolve manually:', e.message);
  }
}

// Rebuild the orders table with a NULLABLE service_id (history rows must
// survive service deletion). No-op on databases that already allow NULL.
function ensureServiceIdNullable() {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  const svc = cols.find((c) => c.name === 'service_id');
  if (!svc || !svc.notnull) return; // already nullable — nothing to do
  console.log('[instasmm] Migrating orders.service_id to nullable (history preservation)…');
  const colList = cols.map((c) => c.name);
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.exec('BEGIN');
  try {
    const ddl = `CREATE TABLE orders_new (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_ref        TEXT UNIQUE NOT NULL,
      user_id          INTEGER NOT NULL REFERENCES users(id),
      service_id       INTEGER REFERENCES services(id),
      provider_id      INTEGER REFERENCES providers(id),
      provider_order_id TEXT,
      link             TEXT NOT NULL,
      quantity         INTEGER NOT NULL,
      price_inr        INTEGER NOT NULL,
      base_cost_inr    INTEGER NOT NULL,
      coupon_id        INTEGER REFERENCES coupons(id),
      discount_inr     INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'PENDING',
      start_count      INTEGER NOT NULL DEFAULT 0,
      remains          INTEGER NOT NULL DEFAULT 0,
      provider_charge  REAL,
      provider_currency TEXT,
      provider_meta    TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    )`;
    db.exec(ddl);
    db.exec(`INSERT INTO orders_new (${colList.join(', ')})
             SELECT ${colList.join(', ')} FROM orders`);
    db.exec('DROP TABLE orders');
    db.exec('ALTER TABLE orders_new RENAME TO orders');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, status)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_prov_order ON orders(provider_id, provider_order_id) WHERE provider_order_id IS NOT NULL');
    db.exec('COMMIT');
    console.log('[instasmm] orders.service_id is now nullable.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.warn('[instasmm] orders.service_id migration failed — demo cleanup aborted:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Seeding — runs only when the users table is empty (first boot).
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  const { users } = count('SELECT COUNT(*) AS users FROM users');
  if (users > 0) return;

  console.log('[instasmm] First boot — seeding database…');
  const now = Date.now();

  // 1) Admin accounts — credentials live ONLY in config.js
  const insUser = db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const [email, password] of Object.entries(config.admins)) {
    insUser.run(email, hashPassword(password), 'admin', 'Admin', 0, 0, 'active', 0, now);
    console.log(`   admin seeded: ${email}`);
  }

  // 2) Settings (keys already ensured by ensureDefaults; keep any explicit rows)
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(config.defaultSettings)) insSetting.run(k, String(v));

  // 3) Demo client + coupons (account-level seed always runs)
  const insDemo = db.prepare(
    `INSERT INTO users (email, password_hash, role, name, wallet_balance, total_spent_inr, status, no_profit, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  // node:sqlite exposes lastInsertRowid on the RESULT of run(),
  // not on the statement object — reading it from the statement
  // yields undefined, and Number(undefined) = NaN binds as NULL
  // (NOT NULL constraint violation on notifications.user_id).
  const demoId = Number(insDemo.run('demo@instasmm.store', hashPassword('demo123'), 'client', 'Demo User', 50000, 0, 'active', 0, now).lastInsertRowid);
  const insCoupon = db.prepare(
    `INSERT INTO coupons (code, type, value, min_order_inr, starts_at, expires_at, active, usage_limit, used_count, created_at)
     VALUES (?,?,?,?,?,?,1,?,0,?)`
  );
  insCoupon.run('WELCOME10', 'percent', 10, 0, now, now + 365 * 24 * 3600 * 1000, null, now);
  insCoupon.run('SAVE100', 'fixed_inr', 10000, 10000, now, now + 365 * 24 * 3600 * 1000, 500, now);

  // 4) Provider + catalog — ONLY in automated-test mode (SMM_TEST=1). A normal
  //    production boot seeds NO provider and NO services: the client surfaces
  //    "Provider not configured" until an admin adds a real provider.
  if (process.env.SMM_TEST === '1') {
    console.log('[instasmm] SMM_TEST=1 — seeding test provider (demo adapter) + catalog…');
    const prov = db.prepare(
      `INSERT INTO providers (name, adapter, api_url, api_key, active, balance, currency, markup_type, markup_value, created_at, updated_at)
       VALUES ('Test Provider (Simulated)', 'demo', NULL, NULL, 1, 100000, 'USD', 'percent', 25, ?, ?)`
    ).run(now, now).lastInsertRowid;

    const categories = [
      ['Instagram', 'instagram', 'camera'],
      ['YouTube', 'youtube', 'play'],
      ['Facebook', 'facebook', 'thumbsUp'],
      ['Twitter / X', 'twitter', 'birds'],
      ['Telegram', 'telegram', 'send'],
      ['TikTok', 'tiktok', 'music'],
    ];
    const insCat = db.prepare('INSERT INTO categories (name, slug, icon, sort, active) VALUES (?,?,?,?,1)');
    const catIdBySlug = {};
    for (const [i, c] of categories.entries()) {
      catIdBySlug[c[1]] = Number(insCat.run(c[0], c[1], c[2], i).lastInsertRowid);
    }

    // [catSlug, name, description, speed, min, max, ratePer1000, type, refill, cancel]
    const svcDef = [
      ['instagram', 'Instagram Followers', 'High-quality Instagram Followers.', '0-30 min', 50, 100000, 12, 'Default', 1, 1],
      ['instagram', 'Instagram Likes', 'Instant Instagram Likes for your post.', '0-15 min', 10, 50000, 7, 'Default', 1, 1],
      ['instagram', 'Instagram Views (Reel)', 'Smooth Reel views delivered gradually.', '10-60 min', 50, 500000, 6, 'Default', 1, 0],
      ['youtube', 'YouTube Subscribers', 'Genuine-looking YouTube Subscribers.', '1-3 hrs', 20, 100000, 45, 'Default', 0, 0],
      ['youtube', 'YouTube Views', 'Retention-friendly YouTube Views.', '0-30 min', 100, 2000000, 3.5, 'Default', 0, 0],
      ['youtube', 'YouTube Likes', 'Fast YouTube Likes on videos.', '0-20 min', 20, 100000, 25, 'Default', 0, 0],
      ['facebook', 'Facebook Followers', 'Facebook Page Followers.', '0-45 min', 20, 200000, 14, 'Default', 1, 0],
      ['twitter', 'Twitter / X Followers', 'Start count starts after 1-2 hours.', '1-2 hrs', 20, 200000, 18, 'Default', 1, 0],
      ['twitter', 'Twitter / X Retweets', 'Retweets on your tweet.', '0-30 min', 10, 50000, 40, 'Default', 0, 0],
      ['telegram', 'Telegram Members', 'Slow-drip Telegram group members.', '1-6 hrs', 25, 100000, 15, 'Default', 1, 0],
      ['telegram', 'Telegram Post Views', 'Instant Telegram channel post views.', '0-10 min', 50, 500000, 4, 'Default', 0, 0],
      ['tiktok', 'TikTok Followers', 'TikTok Followers with minimum drop rate.', '0-1 hrs', 50, 100000, 20, 'Default', 1, 0],
      ['tiktok', 'TikTok Video Likes', 'TikTok video likes.', '0-20 min', 10, 100000, 8, 'Default', 1, 0],
    ];
    const insSvc = db.prepare(
      `INSERT INTO services
         (category_id, provider_id, provider_service_id, name, description, speed_hint,
          min, max, provider_rate, admin_rate, type, refill, cancel, markup_type, markup_value, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'percent',25,1,?)`
    );
    const tSvc = new Map(svcDef.map((s) => [s[1], s]));
    for (const [catSlug, name, desc, speed, min, max, baseRate] of svcDef) {
      const adminRate = Math.round(baseRate * 1.25); // default 25% markup
      const svc = tSvc.get(name);
      insSvc.run(
        catIdBySlug[catSlug], prov,
        `test-svc-${Math.random().toString(36).slice(2, 8)}`,
        name, desc, speed, min, max, baseRate, adminRate, svc ? svc[7] : 'Default',
        svc ? svc[8] : 1, svc ? svc[9] : 0, now
      );
    }
  }

  // Welcome notification goes to the DEMO CLIENT's real row id — with
  // admin accounts seeded first, the demo client is no longer id 2.
  db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, created_at)
     VALUES (?, 'admin', 'Welcome to InstaSMM', 'Your account is ready. Top up your wallet and place your first order!', ?)`
  ).run(demoId, now);

  console.log('[instasmm] Seed complete.');
  console.log('[instasmm]   Demo client : demo@instasmm.store / demo123');
  console.log('[instasmm]   Admins      : see server/config.js');
  console.log('[instasmm]   Demo coupons: WELCOME10 (10%), SAVE100 (₹100 off)');
}

function count(sql) {
  return db.prepare(sql).get();
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : undefined;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
  return value;
}
export function getExchangeRate() {
  return Number(getSetting('exchange_rate') || config.defaultSettings.exchange_rate);
}

// Statement cache for hot call-sites.
export const stmt = {
  userByEmail: () => db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: () => db.prepare('SELECT * FROM users WHERE id = ?'),
  serviceById: () => db.prepare('SELECT * FROM services WHERE id = ?'),
};
