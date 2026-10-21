# Mobikwik merchant QR + automatic crediting: feasibility (draft, not approved)

Status: **NOT feasible as specified. Automatic crediting stays OFF.** No code in this draft calls Mobikwik or YOUPI, and no phone is paired.

Date of review: 19 Oct 2026. Sources: the YOUPI PG source in the scratchpad (`youpi/gateway`), its documentation, and the public PayU documentation for its Mobikwik integration.

## 1. Can YOUPI use a Mobikwik merchant QR/account?

No, on the evidence available.

- YOUPI's provider registry (`packages/common/src/upi-providers.js`) lists MobiKwik only as an app icon with package `com.mobikwik_new`. It is a display entry, not an integration.
- YOUPI attributes a payment only by **amount, receiving account and time window** (`packages/core/src/attribution-engine.js`). Its architecture (Invariant 1 and 2) says this is ambiguous when two payments share an amount on the same account, and it serialises payments with a single active slot per receiving VPA.
- A **static** merchant QR carries no per-payment identifier. Any payer who scans it can pay any amount, and the only link back to a customer is the amount. Two customers paying the same amount during the same window cannot be separated. The "single active slot" limits this but does not remove it, and it means only one customer can pay at a time.
- YOUPI requires a bank-domain sender (`.bank.in`) for SMS and email observations, and an Android notification observation is not a signed bank statement. A Mobikwik merchant notification has no such domain.

**Conclusion:** a static Mobikwik merchant QR cannot be made to give unique per-payment attribution with YOUPI. Automatic crediting from it would credit the wrong customer.

## 2. Is there a Mobikwik merchant webhook or status API?

Not that we can confirm.

- The public PayU documentation for Mobikwik Link & Pay says Mobikwik is accepted through PayU as a wallet bank code (`bankcode=MOBIKWIK`). It names a "Check Status API" but gives **no endpoint, fields, response or signature**. It does not describe a server-to-server webhook for this flow.
- The Mobikwik endpoints in that documentation (`/userbalance`, `/tokengenerate`) are wallet-balance and OTP token calls. They are not payment-status or webhook APIs.
- Using a PayU Link & Pay flow would require a PayU merchant account, which is a payment-gateway agreement, not the static QR the user described.

**Conclusion:** no verified provider signal exists for Mobikwik QR payments. Any Mobikwik adapter would have to invent its fields and status values, which is not permitted.

## 3. Observer app: Mobikwik notification parsing

- `NotificationParser.isRelevantPackage` matches a fixed list plus any package containing `upi`, `bank` or `pay`. `com.mobikwik_new` matches none of these, so **Mobikwik notifications would be dropped** before parsing.
- Even if the filter matched, `parse()` is generic: any notification containing a credit keyword and an amount becomes a payment. It has no Mobikwik-specific format and no check of the sender app's identity.
- `sendObservation` forwards the **full notification title and text** to the server (`rawNotification`). A notification from any matched app, not only the payment line, leaves the phone.
- The SMS path (`SmsReceiver`) forwards **every incoming SMS** (sender, body, timestamp) with no bank filter. This would transmit OTPs and personal messages. It must stay disabled.
- The APK in the repo was not rebuilt from the source. The source has duplicate `.java` and `.kt` classes for the same names, so it does not build as-is. The default base URL is `http://10.0.2.2:6100`, the emulator host alias, which does not reach a physical phone.

**Conclusion:** the observer is unsafe to pair. It would forward personal notification content and SMS, and it cannot see Mobikwik notifications anyway. It must not be paired and its notification listener must not be enabled.

## 4. Decision for the existing system

- The existing `inr_deposits` flow (manual verification by admin, `autoCreditEnabled: false`) remains the only path that credits wallets.
- The provider gate (`server/lib/providerPaymentGate.js`) accepts only `provider_webhook` and `provider_status_api` as sources. Notifications, SMS and redirects are refused, which is correct for this case.
- The `provider_payment_events` table records decisions only.

## 5. What would make automatic crediting possible (all required)

1. A payment provider whose **signed server-to-server webhook** or **status API** returns a per-payment identifier (order ID or equivalent), the exact amount, currency and status, and a bank reference (UTR). The provider's documentation must state the signature header, algorithm and signed bytes.
2. A merchant agreement and KYC that permits settlement to the father's account, confirmed in writing.
3. Sandbox payments that pass end to end, with signature, duplicate, amount and currency tests.
4. Written legal and compliance sign-off, and a tested way to switch the flag off without a deploy.

## 6. Does this need a VPS?

- For a **provider webhook** (option 1 above): no. A provider webhook needs only the existing app's HTTPS endpoint.
- For **YOUPI PG**: yes. It runs seven services on separate ports, and the Android observer requires a long-running server. cPanel cannot host it. A VPS is needed, its cost is not verified, and YOUPI's licence is "Commercial" with no LICENSE file, so it must not be deployed without written permission.

## 7. Next actions for the user (nothing is done without your approval)

1. Ask Mobikwik and PayU in writing whether a merchant can receive a **per-payment** QR or payment link with a **server-side status API or signed webhook**, and whether settlement can go to a personal bank account.
2. If the answer is no, use the existing manual verification for INR deposits, or choose a provider from the research note that meets section 5.
3. Keep the observer unpaired and SMS permission revoked.
