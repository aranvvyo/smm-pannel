# Payment and money-movement routes — enabled versus scaffolded

Checked against the code on branch `compliance/razorpay-review-draft` (base `main` at `6ae50aa`). "Enabled" here means the code path is reachable by a customer under its default configuration. It does not confirm the production database settings or the production environment, which were not inspected.

| Route / feature | Customer-reachable by default? | Basis (code) | Status |
|---|---|---|---|
| Crypto deposit (LTC, USDT BEP20, USDT ERC20) via Apirone | **Yes**, creation is open by default | `maint_crypto_enabled` default `'0'` (`server/config.js`); deposit page offers these three currencies (`client/src/pages/client/Deposit.jsx`) | Live path. Credits happen only after server-side verification with the processor (`server/routes/webhooks.js`, `creditDeposit`). Production processor credentials and their status were not inspected. |
| Crypto webhook `/webhooks/apirone` | Not customer-facing | Token-checked; invoice status re-fetched from the processor before crediting | Live path, with the same caveat as above |
| INR (UPI) deposit page `/deposit/inr` and "Deposit in INR" on Wallet | **No, not by default**. The nav link and the Wallet button are hidden by `INR_DEPOSIT_ENTRY_VISIBLE = false` (`client/src/lib/depositOptions.js`). The page stays reachable by direct URL. | `maint_inr_enabled` default `'1'` pauses new INR deposit creation (`server/lib/depositMaintenance.js`, `assertDepositsOpen`). The page also sets `GATEWAY_CONNECTED = false` (`client/src/pages/client/VcDeposit.jsx`), which disables the automated flow. | Scaffolded. The buttons are visible in the nav and on Wallet, but creation is blocked and the automated flow is disabled. |
| INR automatic crediting (VC Gateway) | **No** | `autoCreditEnabled` is false (`server/config.js`). `creditVerifiedInrDeposit` refuses to credit unless verification is confirmed; it returns `verified-credit-disabled` otherwise (`server/lib/inrVerification.js`). | Scaffolded and disabled. Not to be enabled without owner and verification sign-off. |
| INR manual admin verification | Admin-only (`requireAdmin`), needs a stated reason | `POST /api/admin/deposits/inr/:id/verify` → `verifyInrDeposit` (`server/routes/admin.inrDeposits.js`, `server/lib/inrDeposits.js`) | **Credits the INR wallet directly.** It is not gated by `autoCreditEnabled` or by the deposit pause, so it is a live credit path that stays open regardless of the UI. Credits once, atomically, with a ledger entry and an audit log line. Use in practice was not verified. Owner decision needed: keep, gate behind the pause, or remove. |
| Razorpay | **No** | No Razorpay code exists in the repository. | Not integrated. |
| Customer withdrawal | **No** | No customer-facing withdrawal route exists. | Not offered. |
| Admin withdrawals (treasury payouts to saved addresses) | Admin-only | `server/routes/admin.withdraw.js`, `server/lib/withdrawalExecution.js` | Admin-only. Does not touch customer wallets. |
| Order payment from wallet | Yes | `placeOrder` / `reserveOrder` (`server/lib/orderRouter.js`, `server/lib/orderLifecycle.js`) | Live. Reserve-then-submit, refund once on supplier refusal. |
| Refund to original payment method | **No** | No such code path exists. | Not offered. Refunds are wallet credits. |
| Simulated deposits and demo provider | Test-only | Refused unless `SMM_TEST=1`, and refused in live mode (`server/routes/webhooks.js`) | Not reachable in production by design. |

## Points for the owner

1. The INR entry points are hidden on this branch. Re-enabling them is an owner decision and should happen only after the gateway is verified.
2. The pause defaults are set in code. The production settings table may hold different values. Check the admin Settings page before stating what customers can do.
3. Only the crypto path is credited automatically. The INR path requires separate verification before any credit.
4. Server-side protections, checked independently of the hidden buttons:
   - `POST /api/deposits/inr` (create) and `POST /api/deposits/inr/:id/claim` both call `assertDepositsOpen('inr')` and return 503 while the INR pause is on. The pause default is `'1'` in code.
   - `POST /api/deposits/inr/:id/check` is not behind the pause, but the automated path it uses calls `creditVerifiedInrDeposit`, which returns `auto-credit-disabled` while `autoCreditEnabled` is false. It cannot credit on this configuration.
   - The admin manual verify route is the exception (see the table): it can credit without the pause or the auto-credit flag. Recommended before any INR re-enable: gate it, or remove it, after owner decision. This branch does not change it.
   - Production values of `maint_inr_enabled` and of the environment flags were not inspected.
