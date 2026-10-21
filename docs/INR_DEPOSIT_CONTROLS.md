# INR deposit controls (manual verification, draft)

Status: draft only. Automatic crediting stays OFF (`config.vcGetaway.autoCreditEnabled = false`).

## Who can credit a wallet

Only `verifyInrDeposit` (admin, manual) credits a wallet, and only once per deposit. `creditVerifiedInrDeposit` (automatic) still requires a confirmed provider contract and the config switch, and is not reachable today.

## Rules enforced in code

| Rule | Where | Refused reason |
|---|---|---|
| Customer must own the deposit to claim or read it | `claimInrDeposit`, client routes filter by `user_id` | `not-found` |
| Amount must be an exact rupee/paise value; minimum ₹1.00 | `createInrDeposit`, `inrCreditPaise` | `invalid-amount`, `below-minimum` |
| Wallet credit is the CREDIT amount, never the 10% total | `verifyInrDeposit` | — |
| Payment reference required, 6–35 letters/digits/`-_/`, stored in UPPER case | `normalizePaymentRef` | `payment-ref-required-or-invalid` (400) |
| One bank payment reference verifies at most one deposit (case-insensitive, checked inside the transaction; a database unique index is the backstop once applied) | `verifyInrDeposit` | `payment-ref-already-used` (409) |
| Admin cannot verify a deposit they own | `verifyInrDeposit` | `self-verification-forbidden` (403) |
| Terminal deposits (verified/denied) never change again | conditional `UPDATE … WHERE status IN (...)` | `already-verified` / `already-denied` (409 / 400) |
| Every refused admin credit attempt is written to the security log | `admin.inrDeposits.js` | — |

## Operator actions

- The admin UI requires a payment reference before verifying.
- Verification needs a **second admin account**: the account that issued a deposit cannot verify it. Configure `ADMIN_EMAIL_2` / `ADMIN_PASSWORD_2` before relying on this rule. See the lockout note below.
- Before applying the database index, run the strict preflight on a COPY of production, as a SELECT-only role (see below).

## Database-enforced uniqueness (opt-in, not applied)

- `docs/migrations/PREFLIGHT_inr_payment_ref_unique.sql`: read-only. Groups verified deposits by `UPPER(payment_ref)`. Any row in sections 1 or 2 blocks the index. Resolve those by hand first.
- `docs/migrations/MIGRATION_inr_payment_ref_unique.sql`: builds `idx_inr_deposits_verified_ref` with `CREATE UNIQUE INDEX CONCURRENTLY`. It drops an invalid leftover from a failed run, fails loudly if the index is not valid, and is idempotent. It is never run by the app at startup.
- The old `READONLY_payment_ref_duplicates.sql` (outside the repo) groups by the exact stored string. It misses case-variant duplicates, so use the strict preflight instead.

Running the preflight safely: create a role with `SELECT` only and `default_transaction_read_only = on`, run it against a copy (for example a point-in-time restore to a separate instance), and never against the live primary. The preflight is wrapped in `BEGIN READ ONLY`, and it contains no write or DDL statements.

## Known limits and risks

- **Existing admin credit path bypasses these rules.** `server/lib/wallet.js` (`adminAdjustBalance`, used by `admin.users.js`) lets any admin credit any wallet, including their own, with a free-text reason and no payment reference. The self-verification rule therefore does not stop an admin from funding themselves. This is pre-existing behaviour and was **not changed** here, because it affects unrelated functionality. Decision needed: block self-targeted admin credits, require a second admin, or require a payment reference.
- **Lockout:** with a single admin, that admin cannot verify deposits they requested. Customer deposits are unaffected. The admin can still use the existing admin credit path (see above), so the rule is a separation-of-duties control only for deposits, not a hard barrier.
- The index is partial: denied and pending rows may reuse a reference. This is intended.
- Across processes, a racing verify can be stopped by the unique index and is reported as `payment-ref-already-used`. The PG bridge serialises statements in one process, so the reuse check plus the transaction is the in-process guard.

## Not in this change

- Applying the index to any database.
- A maximum deposit amount. None is specified.
- Changing the admin credit path (see Known limits).
