# 🚀 InstaSMM — instasmm.store

A complete, self-hosted **Social Media Marketing (SMM) panel** with a **Client UI** and an
**Admin UI**, fully automated order routing to up to 5 SMM provider APIs, an INR
wallet funded by **LTC / USDT crypto deposits**, a no-loss coupon engine, support
tickets, notifications, and live admin analytics.

For local testing, run with `SMM_TEST=1` — a self-contained simulator (demo SMM
provider, simulated crypto invoices) exercises every flow with no internet or API
keys. **Production safety:** without that flag the panel refuses to fabricate
invoices, orders or payments — real Apirone credentials (entered in Admin →
Settings) are required before any real money moves.

---

## 🧱 Stack

| Layer     | Tech                                                              |
|-----------|-------------------------------------------------------------------|
| Backend   | Node.js 22 + Express (ESM, plain JavaScript)                      |
| Database  | SQLite via built-in `node:sqlite` (default) **or PostgreSQL** via `DATABASE_URL` (Neon etc.) — both zero native build steps |
| Frontend  | React 18 + Vite 5 SPA (served by Express on the same origin)      |
| Auth      | HttpOnly cookie sessions (~30-day persistent), scrypt password hashes |
| Crypto    | Apirone v2 (LTC · USDT BEP20 · USDT ERC20) with built-in simulated gateway |

Runs on **Termux / Android, Linux, macOS, Windows** — anywhere Node ≥ 22.5 works.

---

## ⚡ Quick start

```bash
# 1) install
npm install

# 2) build the React SPA
npm run build

# 3) start the server (API + SPA on one port)
SMM_TEST=1 npm start   # → http://localhost:3000  (local/test simulator)
# production boot: plain `npm start` (real providers + Apirone only)
```

That’s it. On first boot the database is created and seeded automatically with:

- **6 categories · 14 demo services** (Instagram / YouTube / TikTok / Telegram / X / Facebook)
- A built-in **demo SMM provider** that simulates real order delivery (PENDING → IN_PROGRESS → COMPLETED)
- **Demo client** — `demo@instasmm.store` / `demo123` (₹500 pre-loaded **in `SMM_TEST=1` only**; a production first boot seeds this account at **₹0.00** — no free default credit)
- **Coupons** — `WELCOME10` (10% off) · `SAVE100` (₹100 off)
- **Admins** — see below

---

## 🔐 Admin accounts

Admin credentials are **environment variables** — they never live in the codebase
or in git (a committed admin password would leak publicly on GitHub). Emails on
the configured list are Admins; every other account is strictly a Client.

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL_1` / `ADMIN_PASSWORD_1` | Primary owner (short forms: `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| `ADMIN_EMAIL_2` / `ADMIN_PASSWORD_2` | Optional second owner |

Set them in your shell for local runs; on Render, set them in **Dashboard →
Service → Environment**. If none are set, the app boots with **no admins** and
login is impossible until they are configured.

```bash
export ADMIN_EMAIL_1=you@example.com
export ADMIN_PASSWORD_1='a-strong-password'
npm start               # then sign in at /admin
```

For **local smoke tests** use the same injected creds for both the server boot
and the test runner (they are read from the same env):

```bash
ADMIN_EMAIL_1=smoke-admin@test.dev ADMIN_PASSWORD_1=smoke-verify-pass-123 \
  SMM_TEST=1 DB_FILE=/tmp/instasmm-smoke.db node server/index.js
ADMIN_EMAIL_1=smoke-admin@test.dev ADMIN_PASSWORD_1=smoke-verify-pass-123 \
  node scripts/smoke-test.mjs http://localhost:3000
```

---

## 💰 Payments — real by default, safe by design

**Production boots refuse to fabricate anything.** With no Apirone credentials,
deposit creation returns an error ("must not create fake invoices") — a client is
never handed a made-up address. Orders route to real providers only; the services
list stays empty until an admin adds and syncs a provider.

**Live mode** — an operator enters Apirone credentials once in **Admin → Settings**
(Account ID, Transfer Key, optional Webhook Token). They are stored server-side in
the settings table, write-only, never returned by any API, and never placed in
`.env` or code. Deposits then create **real Apirone invoices** and confirm via the
`/webhooks/apirone` webhook, which re-verifies against Apirone's public
invoice-info endpoint before crediting. The wallet is credited in INR at
`1 USD = 100 INR` (changeable in Admin → Settings).

**Admin withdrawals / sweep** — Admin → Withdraw sends funds OUT of the Apirone
account (a fixed amount or a full sweep) via the documented transfer endpoint.
Every send requires a typed `CONFIRM`, is protected against duplicate submission,
records the gateway's real transfer reference in the audit history (never a
fabricated tx hash), and is written to the security log. The transfer key never
leaves the server.

**INR deposits (VCGetaway — manual verification workflow)** — VCGetaway publishes
no merchant API documentation (verified 2026-10-04: hosted invoice pages with an
"I Have Paid" claim flow only), so INR deposits follow a **safe manual workflow**
(requests are capped at ₹1,000,000,000):
a client requests a deposit → a **pending** record is created with the transparent
10% customer surcharge (the wallet receives the **credit** amount, never the total);
the customer pays the operator-issued UPI invoice (out of band); the customer's
"I have paid" claim is **recorded** (never treated as proof — it credits nothing);
and an **admin verifies the actual payment** before the wallet is credited —
exactly once, atomically, with a full audit trail (`/api/deposits/inr`,
`/api/admin/deposits/inr`). No invoice, QR code, UPI ID or reference is ever
fabricated. Live in the UI: **Deposit → Deposit INR** (`/deposit/inr` — amount
picker with the credit / 10% surcharge / total shown separately, then
"I Have Paid" to record the claim) and **Admin → Deposits → INR (manual)** tab
(verify or deny with a mandatory reason). The automated gateway flow stays
disabled (`GATEWAY_CONNECTED = false`) until an official API contract is obtained.

**Test mode (`SMM_TEST=1`)** — a self-contained simulator: creating a deposit
keeps it **pending**, so creating an invoice is *not* a payment. The wallet is
credited only when an explicit payment event lands (Admin → Deposits → **Confirm**,
or `POST /webhooks/simulator { deposit_id }`). Nothing auto-confirms by default;
the only auto-confirm path is Admin → Settings → *Auto-confirm simulated deposits*,
off by default and intended strictly for non-production demoing.

---

## ☁️ Deploy on Render (free plan)

The app is a **single full-stack Node process** — the built React SPA and the API
share one origin, so no separate static host or CORS setup is needed.

1. **Push this repo** to GitHub, then in Render: **New → Web Service → connect the repo**.
2. **Runtime / plans**
   | Setting | Value |
   |---|---|
   | Build command | `npm install --include=dev && npm run build` |
   | Start command | `npm run start` |
   | Health check | `/api/landing/stats` |
   | Node version | `22.14.0` (set via `NODE_VERSION` env or `engines.node`) |
   | Instance plan | `Free` (spins down when idle) |
3. **Environment variables** (secrets go in Dashboard → Environment, **never** in git):
   - `SESSION_SECRET` — random string (Render can generate one)
   - `ADMIN_EMAIL_1` / `ADMIN_PASSWORD_1` (+ `_2`) — owner accounts
   - `PUBLIC_BASE_URL=https://instasmm.store` — required for real Apirone webhook callbacks & QR codes
   - `THEMAINSMMPROVIDER_API_URL` + `THEMAINSMMPROVIDER_API_KEY` — **optional** supplier credentials (see "Environment-managed configuration" below)
   - `APIRONE_ACCOUNT_ID` + `APIRONE_TRANSFER_KEY` — **optional** crypto-gateway credentials (same section)
   - `APIRONE_API_URL` — Apirone base URL (default `https://apirone.com`)
4. **Database (IMPORTANT).** Two supported backends — pick **one** before first boot:

   **PostgreSQL (recommended for the free plan).** Set
   `DATABASE_URL` to your database URL (e.g. the connection
   string from the **Neon** dashboard — keep its
   `?sslmode=require` parameter). The panel then runs against
   PostgreSQL through a synchronous worker-thread bridge with
   identical behavior, and because the database is external, a
   redeploy never loses data — **no Persistent Disk needed**.
   The database is initialized **fresh** from
   `server/schema.pg.sql` on first boot: existing SQLite data
   is **not** migrated — admins come from the
   `ADMIN_EMAIL_*`/`ADMIN_PASSWORD_*` env vars and providers
   are added again in **Admin → Providers** (deliberate).

   **SQLite (default).** Omit `DATABASE_URL`. Render **free**
   instances have an **ephemeral filesystem** — a default
   `data/instasmm.db` will be wiped on every redeploy. To keep
   data permanently: upgrade the service to a **paid plan**
   (`Starter` ~$7/mo), add a **Persistent Disk** mounted at
   `/var/data` (1 GB), and set `DB_FILE=/var/data/instasmm.db`.
   Zero code change — `DB_FILE` is already env-driven.
   Free only: either accept that a redeploy resets the DB, or
   use an external SQLite-compatible host (e.g. Turso) — the
   latter needs a small DB-layer change.
5. **Custom domain** — in Render: *Settings → Custom Domains* → add `instasmm.store`
   (a subdomain like `app.instasmm.store` is safer while you keep existing site DNS)
   and `www.instasmm.store`; Render issues a Let's Encrypt TLS cert automatically
   (HTTPS is on by default).

A `render.yaml` Blueprint with all of the above (minus secret values) ships in the repo.

### 🐘 PostgreSQL via `DATABASE_URL`

Setting `DATABASE_URL` (a `postgres://…` connection string —
Neon, Supabase, Render Postgres, any managed PostgreSQL) swaps
the storage layer with **zero application changes**: every
route, lib, middleware and all money/order/payment/INR logic
run unchanged against PostgreSQL. The app's SQLite-flavoured
SQL is translated at the database boundary
(`server/lib/pgDialect.js`), and a worker-thread bridge
(`server/lib/pgSync.js`) keeps the fully synchronous
`DatabaseSync` contract the whole codebase is written against —
so transaction atomicity is preserved by construction: nothing
can interleave inside a `BEGIN…COMMIT` block, exactly like a
single SQLite connection. `pg` (node-postgres) is the only
added dependency; the SQLite path needs nothing.

- **Fresh database, deliberately.** The schema is created from
  `server/schema.pg.sql`; **no SQLite data is migrated**. First
  boot seeds exactly like SQLite: admin accounts from
  `ADMIN_EMAIL_*`/`ADMIN_PASSWORD_*`, the demo client at
  **₹0.00**, and — in production — **no provider**, until you
  add one in Admin → Providers and sync.
- **SSL:** if the URL contains `sslmode=require` (Neon always
  does), TLS is used automatically.
- **Verification:** `npm test` runs the dialect unit tests
  (`scripts/test-pg-dialect.mjs` — no database needed) and
  bridge/gate safety tests (`scripts/test-pg-bridge-safety.mjs`
  — no database contacted). The full integration suite is
  gated and runs against a scratch database it creates and
  drops itself; if the scratch database cannot be created it
  aborts — it never falls back to the supplied URL (and never
  runs against one that already contains InstaMM tables):
  ```bash
  TEST_DATABASE_URL='postgres://user:pass@host/db?sslmode=require' \
  PG_TEST_CONFIRM_FRESH=1 npm run test:pg
  ```
- **Cutover checklist (operator):** ① create the PostgreSQL
  database, ② set `DATABASE_URL` in Render Dashboard →
  Environment, ③ set `ADMIN_EMAIL_1`/`ADMIN_PASSWORD_1`,
  ④ deploy — first boot creates the schema and seeds,
  ⑤ add the SMM provider(s) in Admin → Providers and sync
  services, ⑥ enter Apirone credentials in Admin → Settings.
  Keep `DB_FILE` unset (or the SQLite file is ignored).

### 🔑 Environment-managed configuration (survives restarts & redeploys)

Two credential sets can live in Render **Dashboard → Environment** instead of being re-entered in the admin panel after every redeploy:

| Variables | What they manage | Precedence |
|---|---|---|
| `THEMAINSMMPROVIDER_API_URL` + `THEMAINSMMPROVIDER_API_KEY` | one designated SMM supplier (DB row flagged `env_managed`) | The environment is authoritative at every boot: the row's URL/key are brought in line with the variables. Admin panel edits (name, markup, currency, active — even credentials) apply at runtime and hold until the next restart. |
| `APIRONE_ACCOUNT_ID` + `APIRONE_TRANSFER_KEY` | Apirone deposit / withdrawal credentials | A non-blank variable wins; a blank one falls back to the value stored via **Admin → Settings** (stored values are never erased or rewritten). |

Rules that always hold:

- **Blank variables are a no-op** — an empty value can never erase a stored configuration.
- The bootstrap performs **no network calls**. After a first boot, open **Admin → Providers → Sync Services** once to pull the catalog (the existing mechanism — nothing changes about how sync works).
- Providers you create manually (different API URLs) are **never touched** by the bootstrap.
- To run permanently on panel-only credentials: unset the variables in Render — the stored row then stays authoritative.
- Invalid configuration (e.g. a non-https supplier URL) is rejected with a clear error that contains **no credential values**.
- The INR gateway's **automated** flow (VCGetaway) remains disabled (`GATEWAY_CONNECTED=false`) pending official API documentation; the **manual-verification workflow** (request → claim → admin verify → credit) is active server-side — see "INR deposits (VCGetaway)" in the Payments section above.

**Note on data:** environment variables manage *credentials only*. User accounts, wallets, orders, and the ledger live in SQLite — on Render they need a **Persistent Disk** (paid plan + `DB_FILE=/var/data/instasmm.db`, see step 4 above).

---

## 🧭 Using the panel

**Client side**
1. **Sign up** — any email (basic format check), agree to Terms.
2. **Deposit** — pick LTC (🔥 HOT), USDT BEP20 or USDT ERC20, enter USD → get a deposit address.
3. **New Order** — choose a service, paste your target link, set quantity, apply a coupon.
   - Price = `quantity × (rate / 1000)`, shown live. Wallet deducted on placement.
   - Not enough balance? You get a clear “deposit to continue” prompt.
4. **My Orders** — watch progress update live (`start_count` / `remains`).
5. **Support / Notifications** — attach order IDs to tickets; bell shows unread alerts.

**Admin side** — dashboard analytics (profit, profit %, deposits, 14-day charts),
user management (manual credit/debit, one-click ban, “No Profit Users” with the
in-app *Added to Owner’s Favourite List* notification on add only), full service +
markup editor (+ global markup), provider accounts (keys stored server-side, masked
in UI), coupons, order cancel/refill, deposits (incl. manual confirm), withdrawals /
sweep, tickets, audit logs (IST + IP), and settings (exchange rate, timeout,
simulator knobs, own support channels).

---

## 🔒 Security & fair-price design

- **Role isolation** — client and admin APIs are on separate namespaces; every admin
  route is behind `requireAdmin`. Clients get **403** on all of `/api/admin/*`.
- **No price leakage** — clients only ever see the computed sale price. Provider base
  cost, admin rate, markup, and API keys are never serialized to the client.
- **No-loss coupons** — discounts are clamped so the *final price never drops below
  the provider base cost*. The clamp math happens only on the server and is hidden
  from any network response.
- **Positive-price invariant** — an order can never be placed for ₹0 or less:
  service creation/editing rejects non-positive rates and `min < 1`, and order
  placement itself refuses any computed final price `<= 0` (`BAD_PRICE`) **before**
  the provider is called. The wallet debit is an atomic, conditional SQL update
  (`WHERE wallet_balance >= ?`) inside a transaction — concurrent orders can never
  overspend or drive a balance negative, and a failed debit rolls the whole order
  back (releasing the upstream order, with an audit trail if the release fails).
- **Order kill-switch** — set `ORDERS_ENABLED=0` (environment + restart) to pause
  **new customer orders** with a clean 503 while deposits, wallet, history and the
  admin panel keep working. Reversible; no database change. Zero-code alternative:
  set every service to inactive in Admin → Services (reversible in the UI).
- **No Profit Users** — admin-tagged users buy at base (0% markup) price, and get a
  single “Favourite List” notification only when tagged (never when removed).
- Passwords hashed with scrypt; timing-safe comparison; login rate-limiting; sessions
  revoked on ban; audit log records IST timestamps + client IP.

---

## 📦 Packaging

```bash
npm run package      # → instasmm.zip (source, excludes node_modules/data/.env)
npm test             # → money/coupon invariants + provider/settings/ordering regressions + PG dialect units
npm run test:pg      # → PostgreSQL integration invariants (gated: TEST_DATABASE_URL + PG_TEST_CONFIRM_FRESH=1)
node scripts/smoke-test.mjs   # → end-to-end client+admin flow (needs a running server)
```

On a fresh machine: unzip, `npm install`, `npm run build`, `npm start`.

**Demo ticker speed** — the built-in demo provider walks orders PENDING →
IN_PROGRESS → COMPLETED on a real clock (20-80s + 90-270s). To fast-forward the
lifecycle for QA, start the server with `DEMO_SPEED=N` (e.g. `DEMO_SPEED=10 npm start`)
and run the smoke test with the same env prefix to verify the ticker completes
orders. Omit `DEMO_SPEED` for normal production pacing.

---

## 📁 Layout

```
instasmm/
├─ package.json / .env.example
├─ server/          # Express API (config, db, middleware, lib, routes, webhooks)
├─ client/          # React + Vite SPA (src/pages: landing, auth, client, admin)
└─ scripts/         # package.js (zip), smoke-test.mjs (E2E), test-money.mjs + test-regressions.mjs (units)
```

All money is stored as integers (INR paise / USD cents) to avoid float bugs.
All timestamps are stored in UTC epoch-ms; **IST (UTC+5:30)** is used only for display.

© instasmm.store