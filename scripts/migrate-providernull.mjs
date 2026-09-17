// One-off migration: allow orders.provider_id to be NULL (provider deletion)
// and add the unique index services(provider_id, provider_service_id) so the
// provider sync upsert is idempotent. Re-runnable (guards on re-creation).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const dbFile = process.argv[2];
if (!dbFile || !existsSync(dbFile)) {
  console.error('usage: node scripts/migrate-providernull.mjs <dbFile>');
  process.exit(1);
}
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys = ON');

// 1) Unique index for sync upsert (idempotent if it already exists).
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_services_prov_svc ON services(provider_id, provider_service_id)');
  console.log('ok: created idx_services_prov_svc');
} catch (e) {
  // Duplicate provider_service_id rows already exist — dedupe first against the
  // lowest id, mirroring fresh-insert behavior.
  console.warn('unique index failed:', e.message, '— deduping…');
  db.prepare(
    `DELETE FROM services WHERE id NOT IN (
       SELECT MIN(id) FROM services GROUP BY provider_id, provider_service_id)`
  ).run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_services_prov_svc ON services(provider_id, provider_service_id)');
  console.log('ok: deduped then created idx_services_prov_svc');
}

// 2) Rebuild orders so provider_id may be NULL.
const cols = db.prepare('PRAGMA table_info(orders)').all();
const hasNull = cols.find((c) => c.name === 'provider_id');
if (!hasNull) { console.log('orders table missing — nothing to do'); process.exit(0); }

db.exec('PRAGMA defer_foreign_keys = ON');
db.exec('BEGIN');
try {
  db.exec(`CREATE TABLE orders_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_ref        TEXT UNIQUE NOT NULL,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    service_id       INTEGER NOT NULL REFERENCES services(id),
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
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`);
  db.exec(`INSERT INTO orders_new (id, order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity,
             price_inr, base_cost_inr, coupon_id, discount_inr, status, start_count, remains, created_at, updated_at)
           SELECT id, order_ref, user_id, service_id, provider_id, provider_order_id, link, quantity,
             price_inr, base_cost_inr, coupon_id, discount_inr, status, start_count, remains, created_at, updated_at
           FROM orders`);
  db.exec('DROP TABLE orders');
  db.exec('ALTER TABLE orders_new RENAME TO orders');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, status)');
  db.exec('COMMIT');
  console.log('ok: orders.provider_id is now nullable; indexes rebuilt');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('migration failed:', e.message);
  process.exit(1);
}
db.close();
console.log('migration complete.');