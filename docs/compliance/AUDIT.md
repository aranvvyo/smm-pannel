# InstaSMM — Phase One audit (repository and public site)

Status: working document for the owner. Not a legal opinion. Nothing here is published on instasmm.store.

## 1. Repository and deployment

- Branch inspected: `main` at `6ae50aa`. Working branch for this review: `compliance/razorpay-review-draft` (no changes on `main`).
- Remote: `https://github.com/aranvvyo/smm-pannel`.
- Render service `smm-pannel` (`srv-daljhfu5vjqs73fkm4r0`), branch `main`, auto-deploy on commit. Pushing to `main` deploys. Pushing this review branch does not.
- Render's hostname is `smm-pannel-t523.onrender.com`. That the domain `instasmm.store` maps to this service is **not verified**. The public site's `/terms` page could not be read: the site's robots policy disallowed the fetch, and I did not work around it. The owner must confirm which service serves the domain.

## 2. Razorpay status

- **No Razorpay integration exists in the code.** A search of the repository found no references to Razorpay.
- Payment rails present in the code:
  - Crypto deposits through Apirone (LTC, USDT BEP20/ERC20 per the current Terms page). Code: `server/lib/apirone.js`, `server/routes/webhooks.js`.
  - INR UPI deposit scaffold through VC Gateway. Code: `server/lib/vcGatewayAdapter.js`, `server/lib/inrDeposits.js`, `server/routes/client.inrDeposits.js`. Automatic crediting is disabled. Whether it is offered to customers is **not confirmed**.
- A Razorpay merchant review therefore concerns a payment flow that does not exist yet. Any Razorpay checkout would be new work, and it would need its own review.

## 3. Business model (verified from code and landing copy)

- The product resells automated social-media engagement: followers, likes, views and subscribers. Landing copy: "order followers, likes and views in seconds… delivery happen in real time", "Instant Delivery", "No-Loss Guarantee", "Live Tracking".
- Orders are placed with third-party supplier APIs (`server/lib/providers/smmpost.js`). The customer's profile link, the service and the quantity are sent to that supplier.
- Catalogue is imported from supplier service lists and repriced by a markup (`server/lib/providerSync.js`, `server/lib/money.js`). Customers see only final prices.
- The customer wallet is INR, stored in paise. Orders debit the wallet. Crypto and UPI deposits credit it.
- There is no customer-facing withdrawal. Admin withdrawals are treasury payouts to saved addresses and do not touch customer wallets.

## 4. Confirmed issues on the existing public pages

| # | Issue | Where | Severity |
|---|---|---|---|
| A1 | Terms say wallet balances are "non-refundable except at admin discretion". The code refunds rejected and cancelled orders to the wallet automatically or by admin action. The Terms contradict the implementation. | `client/src/pages/client/Terms.jsx` §4 | High |
| A2 | Terms and Privacy are dated "September 2025". No owner, address or effective-date control. | both pages | Medium |
| A3 | Privacy says "We do not sell or share… except as necessary to fulfill orders". It does not name the crypto processor, the UPI processor, supplier APIs, or the hosting provider. | `Privacy.jsx` §4 | High |
| A4 | Privacy says the session cookie "expires after approximately 30 days". Verify against `config.sessionTtlMs` before publishing. | `Privacy.jsx` §5 | Medium |
| A5 | Privacy says "regular security audits" and "encrypted databases". Neither is evidenced in the repository. | `Privacy.jsx` §3, §7 | High |
| A6 | Privacy does not disclose that IP addresses are stored in `security_logs`. | `server/middleware/auth.js`, `server/lib/orderLifecycle.js` | High |
| A7 | No account deletion exists in code. Privacy promises deletion on request via support, but there is no documented procedure. | `Privacy.jsx` §6 | Medium |
| A8 | Footer shows only "InstaSMM · crypto deposits · © … instasmm.store". No About, Contact, Refund, or Payment links. | `client/src/components/Layout.jsx` | High |
| A9 | Landing claims "No-Loss Guarantee", "Instant Delivery", and "Automated orders run 24/7". These overstate delivery. Supplier outcomes are not guaranteed. | `Landing.jsx` lines 29–33 | High |
| A10 | Landing FAQ: "You buy followers, likes and views for your profiles." This describes the product accurately, but eligibility is unconfirmed (see the eligibility note). | `Landing.jsx` line 58 | High |
| A11 | Session cookie is `secure: false`, with a comment about local HTTP hosting. The live site serves HTTPS. This is a security configuration issue for the owner to decide. Not changed in this review. | `server/middleware/auth.js` line 29 | High (security) |
| A12 | Terms: "Deposits are credited in INR based on the prevailing exchange rate". The rate source and timing are not described. | `Terms.jsx` §4 | Medium |

## 5. Safe behaviour that must be preserved

- Atomic wallet debit, one-time refunds, the reserve-then-submit order lifecycle (merged at `6ae50aa`), and the withdrawal guards (merged at `a688634`).
- Automatic INR crediting stays disabled. No payment secrets, environment variables or gateway settings are changed by this review.
- Customer-facing order responses hide supplier identifiers and error text.

## 6. Risks (financial and security)

- Ambiguous supplier outcomes are held, not refunded. The refund policy must describe this honestly. See `drafts/REFUND_CANCELLATION.md`.
- Crypto deposit duplicate and underpayment handling was not re-audited in this pass. The owner should treat it as unverified.
- The lack of a customer-facing refund to the original payment method means a customer who paid in crypto can only receive wallet credit, unless the owner sets up a manual process.
- `secure: false` on the session cookie (A11).
- Provider API keys are stored in the database (`providers.api_key`). Admin-only access is enforced; encryption at rest is not implemented.

## 7. Tests available and limits

- Runnable without Express: `test-order-lifecycle` (15), `test-withdrawal-execution` (14), `test-global-markup` (8), `test-balance-race` (5), `test-crypto-deposits` (13), `test-inr-auto-verify` (52), `test-vc-protocol` (25), and others listed in `package.json`.
- Not runnable here: Express route suites (`test-regressions`, `test-categories`, `test-env-config`, `test-inr-gateway`). `express` is not installed, and the brief forbids installing it to make reports look green.
- Not runnable here: `npm run build` (Vite not installed in `client/`).
- No browser-based responsive or accessibility test was possible in this environment.
- Public-domain checks: blocked by robots policy for `/terms`.

## 8. Status update (second pass, review branch)

Changes made on `compliance/razorpay-review-draft` since `7e2101b`:

- Session cookie: `secure` is now on by default. It was hard-coded `false` before. `COOKIE_SECURE=0` is the only opt-out. Test: `scripts/test-session-cookie.mjs`. Not deployed.
- Landing copy: removed "Instant Delivery", "No-Loss Guarantee", "Best Prices", "in seconds", "24/7", "encrypted cookies" and the claim that cancelled orders return the full amount. Details in the commit diff.
- Refund draft section 4 rewritten from `creditDeposit`: partial payments credit the received fraction; overpayment is capped and not refunded automatically; late payments on expired invoices need manual verification; duplicate notifications are idempotent.
- Privacy draft: verified IP logging (`security_logs`, `sessions.ip`), the 30-day session TTL default, the processor and supplier disclosures, and that no analytics scripts are in the application code.
- Corrected the RAZORPAY_REQUIREMENTS summary of Terms §14.7(vi), which had claimed a notice requirement that the clause does not state.

Still open:

- Footer and legal pages are not implemented. Publishing them requires owner approval, and the drafts still contain REQUIRED fields that would render publicly. No build tool is available to verify JSX.
- Public-domain checks remain blocked (robots policy on instasmm.store).
- Crypto processor credentials in production were not inspected.
