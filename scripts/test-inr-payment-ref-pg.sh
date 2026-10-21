#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# INR payment-reference protection — PostgreSQL tests (real engine, psql only).
#   usage: PGHOST=... PGPORT=... PGUSER=... PGDATABASE=<name>_test \
#          PG_TEST_CONFIRM_FRESH=1 bash scripts/test-inr-payment-ref-pg.sh
# Refuses to run unless PGDATABASE ends in _test and PG_TEST_CONFIRM_FRESH=1.
# It drops and recreates three tables in that database. Never point it at production.
#
# Runs the REAL docs/migrations files (preflight and migration) against scratch data:
#   1. clean data: preflight is empty, migration builds a valid index, guard works
#   2. duplicate verified refs (case variant): preflight reports, migration refuses,
#      and no record is deleted
#   3. blank duplicate verified refs: preflight reports them (regression for a
#      preflight/index mismatch), migration refuses
#   4. recovery: after the blockers are resolved, a re-run succeeds
#   5. two sessions: a second writer waits for the first and is then refused
#   6. repeated verification changes nothing
#   7. an atomic credit rolls back when the ledger insert fails
# ---------------------------------------------------------------------------
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/scripts/support/pg-inr-ref-test-schema.sql"
PREFLIGHT="$ROOT/docs/migrations/PREFLIGHT_inr_payment_ref_unique.sql"
MIGRATION="$ROOT/docs/migrations/MIGRATION_inr_payment_ref_unique.sql"

case "${PGDATABASE:-}" in
  *_test) ;;
  *) echo "REFUSED: PGDATABASE must end in _test (got '${PGDATABASE:-unset}')"; exit 2 ;;
esac
[ "${PG_TEST_CONFIRM_FRESH:-}" = "1" ] || { echo "REFUSED: set PG_TEST_CONFIRM_FRESH=1"; exit 2; }
command -v psql >/dev/null || { echo "BLOCKED: psql not installed"; exit 3; }

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1 — $2"; }
q()    { psql -X -q -At -v ON_ERROR_STOP=1 -c "$1" 2>/tmp/.pgref.err; }
qerr() { psql -X -q -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 >/dev/null; }
reset(){ psql -X -q -v ON_ERROR_STOP=1 -f "$SCHEMA" >/dev/null 2>&1; }
# Rows from preflight query 1 ONLY (the duplicate-group query). Extracted by
# range so the summary query (numbers only) cannot be miscounted as a duplicate.
dup_rows() {
  { echo "BEGIN READ ONLY;"; awk '/^SELECT UPPER\(payment_ref\)/,/;$/' "$PREFLIGHT"; echo "ROLLBACK;"; } \
    | psql -X -q -At -v ON_ERROR_STOP=1 2>/dev/null | grep -c -E '\|'
}
guard_valid() { q "SELECT COUNT(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_inr_deposits_verified_ref' AND i.indisvalid" ; }
run_migration() { psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION" >/tmp/.pgref.mig 2>&1; }
ins() { q "INSERT INTO inr_deposits (user_id,credit_paise,surcharge_paise,total_paise,status,payment_ref,created_at,order_id) VALUES ($1,10000,1000,11000,'$2',$3,0,'ORD$RANDOM$RANDOM')" >/dev/null; }

echo "INR payment-reference PostgreSQL tests — database: $PGDATABASE"

# 1. clean data
reset
ins 1 verified "'UTR000001'"; ins 2 pending "'UTR000001'"; ins 2 denied "'UTR000001'"; ins 1 verified "NULL"; ins 2 verified "NULL"
pre_rows=$(dup_rows)
if [ "$pre_rows" -eq 0 ]; then ok "clean data: preflight reports no duplicate verified references"; else bad "clean data: preflight" "$pre_rows rows reported"; fi
if run_migration && [ "$(guard_valid)" = "1" ]; then ok "clean data: migration builds a VALID guard"; else bad "clean data: migration" "$(tail -2 /tmp/.pgref.mig)"; fi
if qerr "INSERT INTO inr_deposits (user_id,credit_paise,surcharge_paise,total_paise,status,payment_ref,created_at) VALUES (2,10000,1000,11000,'verified','utr000001',0)" | grep -q "duplicate key"; then ok "guard: a case-variant verified reference is refused"; else bad "guard: case-variant" "not refused"; fi
if [ -z "$(qerr "INSERT INTO inr_deposits (user_id,credit_paise,surcharge_paise,total_paise,status,payment_ref,created_at) VALUES (2,10000,1000,11000,'pending','UTR000001',0)")" ]; then ok "guard: pending duplicates are allowed"; else bad "guard: pending" "refused"; fi

# 2. duplicate verified refs
reset
ins 1 verified "'ABC000001'"; ins 2 verified "'abc000001'"
pre_rows=$(dup_rows)
before=$(q "SELECT COUNT(*) FROM inr_deposits")
if [ "$pre_rows" -ge 1 ]; then ok "duplicates: preflight reports the colliding group"; else bad "duplicates: preflight" "reported nothing"; fi
if ! run_migration; then ok "duplicates: migration refuses (non-zero exit)"; else bad "duplicates: migration" "succeeded on duplicate data"; fi
if [ "$(q "SELECT COUNT(*) FROM inr_deposits")" = "$before" ]; then ok "duplicates: no deposit record was removed"; else bad "duplicates: records" "count changed"; fi
if [ "$(guard_valid)" = "0" ]; then ok "duplicates: no VALID guard left behind"; else bad "duplicates: guard" "a valid guard exists"; fi

# 3. blank duplicate verified refs (preflight/index mismatch regression)
reset
ins 1 verified "''"; ins 2 verified "''"
pre_rows=$(dup_rows)
if [ "$pre_rows" -ge 1 ]; then ok "blank duplicates: preflight reports them"; else bad "blank duplicates: preflight" "reported nothing — would pass preflight and then fail the index"; fi
if ! run_migration; then ok "blank duplicates: migration refuses"; else bad "blank duplicates: migration" "succeeded"; fi

# 4. recovery after the blockers are resolved (manual, documented resolution: the operator fixes rows)
reset
ins 1 verified "'REC000001'"; ins 2 verified "'rec000001'"
q "UPDATE inr_deposits SET status='denied' WHERE payment_ref='rec000001'" >/dev/null   # operator resolution (test only)
if run_migration && [ "$(guard_valid)" = "1" ]; then ok "recovery: re-run succeeds once blockers are resolved"; else bad "recovery" "$(tail -2 /tmp/.pgref.mig)"; fi

# 5. two sessions: the second writer waits, then is refused
reset
ins 1 verified "NULL"; ins 1 pending "'RACE00001'"; ins 2 pending "'RACE00001'"
ids=$(q "SELECT string_agg(id::text, ',' ORDER BY id) FROM inr_deposits WHERE status='pending'")
a_id=${ids%%,*}; b_id=${ids##*,}
run_migration >/dev/null
( psql -X -q -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE inr_deposits SET status='verified', payment_ref='RACE00001' WHERE id=$a_id; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
start=$(date +%s)
err=$(qerr "UPDATE inr_deposits SET status='verified', payment_ref='race00001' WHERE id=$b_id")
waited=$(( $(date +%s) - start ))
wait
if echo "$err" | grep -q "duplicate key" && [ "$waited" -ge 1 ]; then ok "concurrency: second writer waited ${waited}s, then was refused (duplicate key)"; else bad "concurrency" "err='$err' waited=${waited}s"; fi

# 6. repeated verification
reset
ins 1 pending "NULL"; id=$(q "SELECT id FROM inr_deposits ORDER BY id DESC LIMIT 1")
first=$(psql -X -q -At -c "WITH u AS (UPDATE inr_deposits SET status='verified', payment_ref='RPT000001' WHERE id=$id AND status IN ('pending','awaiting_verification') RETURNING 1) SELECT COUNT(*) FROM u")
second=$(psql -X -q -At -c "WITH u AS (UPDATE inr_deposits SET status='verified', payment_ref='RPT000001' WHERE id=$id AND status IN ('pending','awaiting_verification') RETURNING 1) SELECT COUNT(*) FROM u")
if [ "$first" = "1" ] && [ "$second" = "0" ]; then ok "repeat verification: first flips the row, second changes nothing"; else bad "repeat verification" "first=$first second=$second"; fi

# 7. atomic credit rollback
reset
ins 1 pending "NULL"; id=$(q "SELECT id FROM inr_deposits ORDER BY id DESC LIMIT 1")
before_bal=$(q "SELECT COALESCE(SUM(wallet_balance),0) FROM users")
psql -X -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<SQL
BEGIN;
UPDATE inr_deposits SET status='verified', payment_ref='ROLL00001' WHERE id=$id AND status IN ('pending','awaiting_verification');
UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id=1;
INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, created_at) VALUES (1, NULL, 100, 0, $id, 0);
COMMIT;
SQL
st=$(q "SELECT status FROM inr_deposits WHERE id=$id"); bal=$(q "SELECT COALESCE(SUM(wallet_balance),0) FROM users")
if [ "$st" = "pending" ] && [ "$bal" = "$before_bal" ]; then ok "atomic credit: a failed ledger insert rolls back status and balance"; else bad "atomic credit" "status=$st balance $before_bal->$bal"; fi

echo ""
echo "inr-payment-ref-pg: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
