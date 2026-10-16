-- ===========================================================================
-- InstaSMM — PostgreSQL schema (used when DATABASE_URL is set)
--
-- A faithful port of server/schema.sql. Differences are PostgreSQL-only:
--   • `INTEGER PRIMARY KEY AUTOINCREMENT`
--       → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
--     (SQLite's INTEGER is 64-bit; PostgreSQL's INTEGER is 32-bit and
--     epoch-millisecond timestamps and INR-paise money values exceed
--     that range, so EVERY integer column is BIGINT here)
--   • `REAL` → `DOUBLE PRECISION` (same 8-byte IEEE semantics)
--   • no PRAGMAs (foreign keys are always enforced in PostgreSQL)
--
-- Money is stored as INTEGER whole subunits to avoid float drift:
--   INR amount  => paise (₹1.00 = 100)
--   USD amount  => cents ($1.00 = 100)
-- Timestamps    => UNIX epoch milliseconds (UTC). IST only at display time.
--
-- This schema creates a FRESH application database. Existing SQLite
-- data is intentionally NOT migrated — the operator initializes the
-- new database deliberately (admins and providers are re-entered).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'client',          -- 'admin' | 'client'
  name           TEXT,
  wallet_balance BIGINT NOT NULL DEFAULT 0,               -- INR in paise
  total_spent_inr BIGINT NOT NULL DEFAULT 0,              -- INR in paise
  status         TEXT NOT NULL DEFAULT 'active',           -- 'active' | 'banned'
  no_profit      BIGINT NOT NULL DEFAULT 0,               -- 1 = owner's favourite (0% markup)
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS categories (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name    TEXT NOT NULL,
  slug    TEXT UNIQUE NOT NULL,
  icon    TEXT,
  sort    BIGINT NOT NULL DEFAULT 0,
  active  BIGINT NOT NULL DEFAULT 1
);

-- Provider row. api_url / api_key are SERVER-SIDE ONLY and are never
-- serialized into any response.
CREATE TABLE IF NOT EXISTS providers (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  adapter      TEXT NOT NULL DEFAULT 'smmpost', -- 'smmpost' (production) | 'demo' (test-only)
  api_url      TEXT,
  api_key      TEXT,
  env_managed  BIGINT NOT NULL DEFAULT 0,  -- 1 = row is managed by the
                                             -- THEMAINSMMPROVIDER_* env vars
                                             -- (server/lib/managedProvider.js)
  active       BIGINT NOT NULL DEFAULT 1,
  balance      DOUBLE PRECISION,                    -- last known provider balance
  currency     TEXT NOT NULL DEFAULT 'USD',          -- provider billing currency
  markup_type  TEXT NOT NULL DEFAULT 'percent',      -- 'percent' | 'fixed' (customer pricing)
  markup_value DOUBLE PRECISION NOT NULL DEFAULT 25,
  last_sync_at BIGINT,                               -- last successful service sync
  last_success_at BIGINT,                            -- last successful API call (test/status)
  last_error   TEXT,                                 -- last API error message (never contains keys)
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id        BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  provider_id        BIGINT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_service_id TEXT,
  name               TEXT NOT NULL,
  description        TEXT,
  speed_hint         TEXT,            -- "0-15 min" etc (admin/provider supplied)
  type               TEXT,            -- provider service type (Default/Comments/...)
  min                BIGINT NOT NULL DEFAULT 1,
  max                BIGINT NOT NULL DEFAULT 999999,
  provider_rate      DOUBLE PRECISION NOT NULL,   -- base cost per 1000 (server-side only
                                                        -- for normal users; the selling price driver)
  admin_rate         DOUBLE PRECISION NOT NULL,   -- selling rate per 1000
  quality            TEXT,            -- provider quality tier, when supplied
  markup_type        TEXT NOT NULL DEFAULT 'percent',  -- 'percent' | 'fixed'
  markup_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
  refill             BIGINT NOT NULL DEFAULT 0,      -- provider supports refill
  cancel             BIGINT NOT NULL DEFAULT 0,      -- provider supports cancel
  status             BIGINT NOT NULL DEFAULT 1,      -- 1 active, 0 disabled
  created_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_cat ON services(category_id);
CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);
-- One row per (provider, upstream service) so sync upserts are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_prov_svc ON services(provider_id, provider_service_id);

CREATE TABLE IF NOT EXISTS orders (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_ref        TEXT UNIQUE NOT NULL,   -- public "Order ID" shown to users
  user_id          BIGINT NOT NULL REFERENCES users(id),
  service_id       BIGINT REFERENCES services(id),   -- NULL when the service is deleted (history preserved)
  provider_id      BIGINT REFERENCES providers(id),  -- NULL after provider deletion (history preserved)
  provider_order_id TEXT,
  link             TEXT NOT NULL,
  quantity         BIGINT NOT NULL,
  price_inr        BIGINT NOT NULL,       -- sale price, paise
  base_cost_inr    BIGINT NOT NULL,       -- provider cost, paise (server-side only)
  coupon_id        BIGINT REFERENCES coupons(id),
  discount_inr     BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  start_count      BIGINT NOT NULL DEFAULT 0,
  remains          BIGINT NOT NULL DEFAULT 0,
  provider_charge  DOUBLE PRECISION,       -- provider-charged amount (status sync)
  provider_currency TEXT,                   -- provider billing currency for charge
  provider_meta    TEXT,                   -- JSON extras from provider (supplier id, etc)
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, status);
-- Idempotency guard for placeOrder: a provider order id is accepted exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_prov_order ON orders(provider_id, provider_order_id) WHERE provider_order_id IS NOT NULL;

-- Wallet ledger (single source of truth for balance changes)
CREATE TABLE IF NOT EXISTS transactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,            -- deposit|order|refund|admin_credit|admin_debit
  amount_inr    BIGINT NOT NULL,          -- signed, paise
  balance_after BIGINT NOT NULL,
  ref_id        BIGINT,                   -- related order/deposit id
  meta_json     TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS deposits (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  invoice_id     TEXT,                    -- Apirone invoice id (or sim id)
  currency       TEXT NOT NULL,           -- LTC | BEP20_USDT | ERC20_USDT
  amount_usd     BIGINT NOT NULL,         -- cents
  amount_inr     BIGINT NOT NULL,         -- paise (credited amount)
  address        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|confirmed|failed|expired|rejected
  is_simulated   BIGINT NOT NULL DEFAULT 0,
  paid_usd       BIGINT NOT NULL DEFAULT 0,  -- cumulative USD cents credited
  received_minor DOUBLE PRECISION,          -- cumulative crypto minor units verified received
  tx_hash        TEXT,                       -- last verified on-chain txid (real only, never fabricated)
  provider_event TEXT,                    -- last raw webhook event that touched it
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL,
  paid_at        BIGINT,
  confirmed_at   BIGINT,
  -- Apirone real-payment support: minor units for crypto amounts,
  -- currency code as Apirone knows it, cumulative USD cents credited
  -- so far, plus verified-receipt fields.
  amount_minor   DOUBLE PRECISION,
  currency_code  TEXT,
  reject_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, status);
CREATE INDEX IF NOT EXISTS idx_deposits_invoice ON deposits(invoice_id);

CREATE TABLE IF NOT EXISTS coupons (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  type          TEXT NOT NULL,            -- 'percent' | 'fixed_inr'
  value         DOUBLE PRECISION NOT NULL, -- percent (0-100) or INR paise for fixed
  min_order_inr BIGINT NOT NULL DEFAULT 0, -- min order subtotal (paise) to apply
  starts_at     BIGINT,
  expires_at    BIGINT,
  active        BIGINT NOT NULL DEFAULT 1,
  usage_limit   BIGINT,                  -- NULL = unlimited
  used_count    BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_uses (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coupon_id      BIGINT NOT NULL REFERENCES coupons(id),
  user_id        BIGINT NOT NULL REFERENCES users(id),
  order_id       BIGINT,
  discount_inr   BIGINT NOT NULL,
  created_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL,           -- target user (or 0 = broadcast)
  type       TEXT NOT NULL,              -- deposit|order|admin|account|general
  title      TEXT NOT NULL,
  body       TEXT,
  read_at    BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS tickets (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  subject    TEXT NOT NULL,
  order_id   BIGINT,                    -- optional attached order
  priority   TEXT NOT NULL DEFAULT 'medium',
  status     TEXT NOT NULL DEFAULT 'open', -- open|pending|closed
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,
  sender_role TEXT NOT NULL,             -- 'client' | 'admin'
  body        TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_logs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT,
  email      TEXT,
  action     TEXT NOT NULL,              -- login|failed_login|logout|ban|unban|admin_credit|...
  ip         TEXT,
  detail     TEXT,                       -- optional audit context (reason, references)
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_logs ON security_logs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Admin crypto withdrawal / sweep history. Real provider transfers only — the
-- transfer reference (or an explicit failure) is always recorded, and a tx hash
-- is NEVER fabricated. Idempotency: one key per submission attempt, and the
-- server refuses a fresh duplicate within a short window before API calls.
CREATE TABLE IF NOT EXISTS withdrawals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id         BIGINT NOT NULL REFERENCES users(id),
  currency         TEXT NOT NULL,            -- LTC | TRC20_USDT | BEP20_USDT | ERC20_USDT
  currency_code    TEXT,                     -- ltc | usdt@trx | usdt@bnb | usdt@eth
  address          TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'amount',  -- 'amount' | 'sweep'
  amount_minor     DOUBLE PRECISION NOT NULL,    -- crypto minor units sent
  amount_usd       BIGINT NOT NULL DEFAULT 0,      -- USD cents (value at send)
  rate_inr         BIGINT,                  -- INR exchange rate at send
  fee              TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'priority' | 'custom' (Apirone transfer fee policy)
  subtract_fee     BIGINT NOT NULL DEFAULT 1,
  transfer_ref     TEXT,                     -- provider transfer/payment id (never a fake hash)
  tx_hash          TEXT,                     -- real on-chain transaction hash from the gateway (when reported)
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
  error            TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       BIGINT NOT NULL,
  executed_at      BIGINT,
  confirmed_at     BIGINT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_admin ON withdrawals(admin_id, created_at);

-- Owner-saved withdrawal addresses: one validated address per currency/network.
-- Set exclusively through the admin-only endpoints; the withdrawal flow always
-- reads from here and never asks for an address again (endpoint-only, so the
-- volume of an address is never presented to a client).
CREATE TABLE IF NOT EXISTS withdraw_addresses (
  currency   TEXT PRIMARY KEY,               -- LTC | TRC20_USDT | BEP20_USDT | ERC20_USDT
  address    TEXT NOT NULL,                  -- validated for that network
  network    TEXT NOT NULL,                  -- 'Litecoin' | 'TRC20' | 'BEP20' | 'ERC20'
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Manual INR (VCGetaway) deposit workflow. VCGetaway publishes no
-- merchant API documentation, so every INR payment is UNVERIFIED until
-- an authorized admin verifies the actual payment. The wallet is
-- credited the CREDIT amount (never the surcharge-inclusive total)
-- exactly once, atomically with the ledger entry. The crypto `deposits`
-- table is a separate flow and is untouched by this workflow.
CREATE TABLE IF NOT EXISTS inr_deposits (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  credit_paise    BIGINT NOT NULL,     -- wallet credit the customer requested
  surcharge_paise BIGINT NOT NULL,     -- 10% customer surcharge
  total_paise     BIGINT NOT NULL,     -- what the customer must pay
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|awaiting_verification|verified|denied
  invoice_ref     TEXT,                 -- gateway invoice reference (recorded when known)
  payment_ref     TEXT,                 -- UPI/transaction reference the admin verified
  verified_by     BIGINT REFERENCES users(id),
  verify_note     TEXT,
  created_at      BIGINT NOT NULL,
  verified_at     BIGINT,
  order_id        TEXT                  -- INSTA SMM GATEWAY order id (server-generated, unique)
);
CREATE INDEX IF NOT EXISTS idx_inr_deposits_user ON inr_deposits(user_id, status);
-- The UNIQUE index on order_id is NOT created here. On an existing database this
-- table already exists without order_id, so CREATE TABLE IF NOT EXISTS is a no-op
-- and an index here would abort startup. db.js ensureColumnsPg adds the column,
-- then creates idx_inr_deposits_order.

-- Customer refill requests (see schema.sql for status meanings).
CREATE TABLE IF NOT EXISTS order_refill_requests (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            BIGINT NOT NULL REFERENCES orders(id),
  user_id             BIGINT NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL,
  provider_refill_id  TEXT,
  provider_status     TEXT,
  provider_checked_at BIGINT,
  reason              TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refill_order ON order_refill_requests(order_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refill_inflight ON order_refill_requests(order_id)
  WHERE status IN ('REQUESTED','AMBIGUOUS');
