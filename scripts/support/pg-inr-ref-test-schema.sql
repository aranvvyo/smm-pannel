-- Minimal PostgreSQL subset for test-inr-payment-ref-pg.sh. It copies the column
-- types of server/schema.pg.sql for inr_deposits, transactions and users, and
-- nothing else. Used ONLY inside a fresh *_test database.
DROP TABLE IF EXISTS transactions, inr_deposits, users;
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client', wallet_balance BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE inr_deposits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  credit_paise BIGINT NOT NULL, surcharge_paise BIGINT NOT NULL, total_paise BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', invoice_ref TEXT, payment_ref TEXT,
  verified_by BIGINT REFERENCES users(id), verify_note TEXT, created_at BIGINT NOT NULL,
  verified_at BIGINT, order_id TEXT
);
CREATE TABLE transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id), type TEXT NOT NULL,
  amount_inr BIGINT NOT NULL, balance_after BIGINT NOT NULL, ref_id BIGINT, meta_json TEXT, created_at BIGINT NOT NULL
);
INSERT INTO users (email, password_hash) VALUES ('a@t.dev','x'), ('b@t.dev','x'), ('admin@t.dev','x');
