-- OPT-IN MIGRATION. NOT run by the application at startup.
--
-- Run ONLY when ALL of these hold:
--   1. docs/migrations/PREFLIGHT_inr_payment_ref_unique.sql returned ZERO rows in
--      its sections 1 and 2 on a copy of the production database;
--   2. the owner has approved running it against production in writing.
--
-- Effect: a verified INR deposit's payment reference (case-insensitive) can belong
-- to at most one verified deposit. Pending and denied rows are not affected.
--
-- Run as a standalone psql script (CONCURRENTLY cannot run inside a transaction):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f MIGRATION_inr_payment_ref_unique.sql
--
-- Safety: a failed CONCURRENTLY build leaves an INVALID index that still exists.
-- Step 1 drops such an index so step 2 rebuilds it. Step 2 has no IF NOT EXISTS,
-- so the script fails loudly instead of silently keeping a missing guard.
-- Step 3 verifies that the index is valid.

-- Step 1: drop only an INVALID leftover from an earlier failed run.
SELECT 'DROP INDEX CONCURRENTLY idx_inr_deposits_verified_ref'
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'idx_inr_deposits_verified_ref' AND NOT i.indisvalid
\gexec

-- Step 2: build the index unless a VALID one already exists.
SELECT 'CREATE UNIQUE INDEX CONCURRENTLY idx_inr_deposits_verified_ref ON inr_deposits (UPPER(payment_ref)) WHERE status = ''verified'' AND payment_ref IS NOT NULL'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'idx_inr_deposits_verified_ref' AND i.indisvalid
)
\gexec

-- Step 3: fail unless the guard is present and valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_inr_deposits_verified_ref' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_inr_deposits_verified_ref is missing or invalid';
  END IF;
END
$$;
