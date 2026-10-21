-- READ-ONLY PREFLIGHT for the proposed unique index on verified INR payment refs.
-- Matches the index rule exactly: UPPER(payment_ref), status = 'verified'.
-- Contains SELECT statements only, inside a READ ONLY transaction. Changes nothing.
-- Run on a COPY of production, or with a role that has SELECT only (see docs).
BEGIN READ ONLY;

-- 1. Verified deposits with a reference used by more than one verified deposit
--    (case-insensitive). ANY row here blocks the index: resolve it by hand first.
--    The WHERE clause must match the index predicate in the migration exactly.
--    Blank references are included on purpose: two verified blank references
--    collide in the index, so they must be reported here.
SELECT UPPER(payment_ref)                  AS payment_ref_upper,
       COUNT(*)                            AS verified_uses,
       ARRAY_AGG(id ORDER BY id)           AS deposit_ids
FROM inr_deposits
WHERE status = 'verified' AND payment_ref IS NOT NULL
GROUP BY UPPER(payment_ref)
HAVING COUNT(*) > 1
ORDER BY verified_uses DESC;

-- 2. Verified deposits whose reference is blank after trimming. A single blank is not
--    a duplicate, but it indicates a bad historical record. Review, do not auto-fix.
SELECT id, status, payment_ref
FROM inr_deposits
WHERE status = 'verified' AND payment_ref IS NOT NULL AND TRIM(payment_ref) = '';

-- 3. Summary for the record.
SELECT COUNT(*)                                                       AS total_deposits,
       COUNT(*) FILTER (WHERE status = 'verified')                    AS verified,
       COUNT(*) FILTER (WHERE status = 'verified' AND payment_ref IS NOT NULL) AS verified_with_ref
FROM inr_deposits;

ROLLBACK;
