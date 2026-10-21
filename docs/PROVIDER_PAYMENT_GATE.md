# INR Provider Payment Gate — Design, Requirements and Open Decisions

Status: **draft, not deployed, automatic wallet crediting OFF.**

## 1. What is implemented (this draft only)

`server/lib/providerPaymentGate.js` is a pure, provider-independent module:

- `verifyWebhookSignature` — HMAC-SHA256 over the **raw** request body, `sha256=<hex>` header, constant-time comparison. Fails closed on a missing or short secret (minimum 32 characters), a malformed header, a parsed body, or a mismatch.
- `evaluateProviderEvent` — decides what a normalised provider event means for an existing `inr_deposits` row. Checks, in order: trusted source (`provider_webhook` or `provider_status_api` only; device notifications, SMS, browser redirects and client claims are refused), event id present (≤200 chars), exact order id, status in `SUCCESS | FAILED | EXPIRED | CANCELLED`, currency exactly `INR`, amount an integer number of paise exactly equal to `total_paise` (credit plus 10% surcharge), then the deposit's current state. It returns a decision and performs no writes.
- `isDuplicateEvent` — in-memory duplicate check for tests and batch callers. Production idempotency must be a database UNIQUE constraint on the stored provider event id.

Crediting is never performed by this module. Even with `autoCreditEnabled: true`, a SUCCESS yields `creditAllowed: true` as a decision only. A credit must still go through the existing transactional `verifyInrDeposit` path, which credits the **credit** amount (never the total) once.

- `provider_payment_events` table (`server/schema.sql` and `server/schema.pg.sql`): an append-only log of accepted and refused provider events, with `UNIQUE (provider, event_id)` so a repeated delivery is rejected by the database. It records decisions only and never touches the wallet or deposit rows. It is a new table, created with `IF NOT EXISTS`, with no change to existing tables. Not applied to any database.

Tests: `scripts/test-provider-deposit-gate.mjs` (49 checks) and `scripts/test-provider-event-schema.mjs` (6 checks, SQLite temporary file). Both pass.

Not implemented, deliberately:
- No provider adapter, endpoint, field name or signing scheme. None is chosen.
- No route registration, no change to `server/index.js`, no change to existing tables, no change to crypto deposits, the existing INR gateway, orders, providers, or production configuration.

## 2. Required before any provider adapter is written

1. Choose the provider (see section 5).
2. Read that provider's current official documentation for: payment creation, webhook signature header and signed content, event names, retry behaviour, and a server-side status API.
3. Confirm the provider's settlement model: where customer payments are settled, and whether a personal UPI ID can be a receiving account at all.
4. Decide the amount-attribution model (section 4).

## 3. Enablement gates (all must pass before automatic crediting is turned on)

1. Provider sandbox or test-mode payments succeed end to end.
2. Signature verification rejects tampered, re-signed-with-wrong-secret and replayed bodies.
3. Duplicate webhook deliveries produce exactly one wallet credit.
4. Amount-mismatch and currency-mismatch events never change a deposit.
5. A status check against the provider's API confirms every SUCCESS before crediting.
6. Written legal and compliance sign-off for automatic crediting.
7. Operator sign-off, and a tested rollback that disables the flag without a deploy.

## 4. Attribution risk (decision required)

A UPI collect or QR payment with no per-transaction reference can be matched only by amount and time. A different sender paying the same amount in the same window can be credited to the wrong customer. Options:

- **A.** Use a provider that returns a per-payment identifier and status for each QR or virtual account (the Razorpay QR model below). This removes amount-only matching but depends on the provider's flow.
- **B.** Keep manual verification for INR deposits (the current design) and automate only after A is proven.
- **C.** YOUPI PG's amount-only, single-slot model. Not recommended without a formal risk decision, and blocked until licensed.

## 5. Provider comparison (from official documentation read on 2026-10-19)

| Topic | Razorpay (UPI QR / Virtual Account) | Cashfree (Payment Gateway) |
|---|---|---|
| Per-payment QR | Yes: a separate request creates a QR code per payment, with an `id` and `amount_expected` (paise). Source: [Razorpay UPI QR API](https://razorpay.com/docs/payments/payment-methods/upi-qr/api) | Dynamic QR and UPI intent are documented; the specific QR request was not read in full. Source: [Cashfree webhooks](https://www.cashfree.com/docs/api-reference/webhooks/payloads-and-signatures.md) (signature scheme only) |
| Server-side status | `GET /virtual_accounts/:id` and `GET /virtual_accounts/:id/payments`. Payment-level status values were not listed on the page read. | Not stated on the page read; must be checked in the payments reference |
| Webhook signature | Not stated on the page read; the webhook page linked from it was missing | `x-webhook-signature` (HMAC-SHA256, Base64) over `x-webhook-timestamp` + raw body. Source: [Cashfree payloads and signatures](https://www.cashfree.com/docs/api-reference/webhooks/payloads-and-signatures.md) |
| Event names | Not confirmed | `PAYMENT_SUCCESS`, `payment_status: SUCCESS` (sample) |
| Transaction reference (UTR) in status | Not confirmed on the page read | Not confirmed |
| Settlement to a personal UPI ID | **Not confirmed; appears to settle to the merchant's bank account linked to the Razorpay account.** | Not confirmed; the merchant must hold a payment-gateway account |
| Onboarding | Account plus `virtual_account` feature; Smart Collect onboarding if not enabled | Merchant account with KYC; not read in detail |

**Assessment (provisional):** Razorpay's documented model is closer to what InstaSMM needs: one QR per payment with an identifier and an amount, and server-side status retrieval. Cashfree's webhook signing is documented clearly, which helps the signature gate. Neither was confirmed to accept a personal UPI ID as the receiving account, so **neither is suitable for "father's UPI ID as receiver" without confirmation from the provider.** Confirm with the provider in writing before choosing.

## 6. YOUPI PG minimum hosting (if it is ever used)

From its documentation, and not independently tested:
- Node.js 20 or newer (the repository's `package.json` says `>=20.0.0`).
- Seven services on separate ports: 6100, 7000, 6001, 5000, 6002, 6003, 8090. A cPanel Node.js application serves a single port and cannot run this set. Needs a VPS, or another host that allows multiple long-running processes and inbound ports.
- SQLite by default (`data/`), or PostgreSQL via `DATABASE_URL`. Must be a separate database from InstaSMM's.
- HTTPS termination (NGINX, Caddy or Cloudflare Tunnel) for the webhook and the observer.
- CPU and RAM sizing: **not stated in the documentation; must be requested from the vendor.**

## 7. Licensing permission needed for YOUPI PG

Its `package.json` says `"license": "Commercial"`, and the repository has no LICENSE file. Before any use, a written licence must grant, for InstaSMM's business:
- the right to run it on a server InstaSMM controls;
- the right to modify it (the repo contains destructive reset scripts that would have to be disabled);
- the right to use it for commercial payment collection;
- the right to use it with the bundled Android observer APK, including redistribution if the APK is installed on a third-party device.

Without this, the YOUPI PG code must not be integrated or deployed.

## 8. Remaining blockers

- Provider choice and written confirmation of the settlement model.
- YOUPI PG licence (section 7), if YOUPI is still considered.
- A VPS, if YOUPI is considered.
- Legal and compliance review of automatic crediting and of an observer that reads a family member's phone notifications.
- Provider sandbox credentials. None were used; none have been requested.
