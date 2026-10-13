# Owner checklist and publication status

## 1. Changes on the review branch

Done (on `compliance/razorpay-review-draft` only, not deployed):
- Landing copy: overclaims removed (see section 8).
- Terms §4 (`client/src/pages/client/Terms.jsx`): the "non-refundable except at admin discretion" statement is replaced with what the code does (wallet-only refunds; supplier refusals refunded once; other refunds decided by the operator; no wallet withdrawal).
- Privacy (`client/src/pages/client/Privacy.jsx`): removed "encrypted databases", "regular security audits", "do not store personal information" (cookies), and "no sharing" wording; named the processor, supplier and hosting categories; IP logging disclosed; account deletion described as manual.

Still open, needing your decision:
- Footer links to About, Contact, Terms, Privacy, Refund, Payment & Delivery. Not added: the About/Contact/Refund/Payment pages do not exist yet, and their drafts contain REQUIRED fields.
- Publishing the drafts in `drafts/` (owner approval and the REQUIRED fields first).

## 2. Draft content awaiting owner approval
- `drafts/REFUND_CANCELLATION.md`
- `drafts/PRIVACY_POLICY.md`
- `drafts/TERMS_AND_CONDITIONS.md`
- `drafts/ABOUT_CONTACT_PAYMENT.md`

## 3. Missing facts preventing publication
- **Physical business address — REQUIRED, OWNER MUST PROVIDE.** Not supplied. Not invented.
- Support email: supplied as arnavsingh98001@gmail.com, not verified. Earlier drafts and the review workspace used a different address. Please confirm which address is the support address; this review does not substitute one for the other.
- Support phone 7457945493: supplied, not verified.
- Support hours, response time, escalation contact, and any grievance officer.
- Business history statement (About Us) — only if you can state it accurately.
- Which payment methods are live for customers.
- Cookie lifetime, retention periods, legal bases, and DPDP Act wording (confirm with a lawyer).
- Refund timeframes and the crypto overpayment/duplicate-payment process.
- GST status and the tax treatment of wallet deposits and orders (not confirmed; do not state either way).
- Proprietor name and billing label confirmation with Razorpay.
- Whether `instasmm.store` is served by this repository's Render service. Not verified from here.

## 4. Services requiring Razorpay confirmation
- Purchased social-media engagement (followers, likes, views, subscribers) — eligibility not confirmed. Razorpay Terms §14.7(vi) and §14.10 bind payments to the approved description.
- Subcategory "Ad and Marketing" — confirm it matches the actual service.
- Every active catalogue item must be reviewed individually before any Razorpay application.

## 5. Technical defects preventing payment readiness
- No Razorpay integration exists. Razorpay checkout would be new development requiring its own review.
- Session cookie `secure: false` (auth middleware). Owner decision required; the live site uses HTTPS.
- No account self-deletion; no retention purge job.
- Provider API keys stored in the database without encryption at rest.
- Crypto deposit handling verified in code (partial credit, overpayment cap, idempotent credit). Live behaviour with real funds is not tested and must not be tested without owner approval.
- No customer-facing refund to original payment method exists.

## 6. Go / no-go
**Do not submit this website to Razorpay for merchant review yet.** The blockers are sections 3 and 4 above. Publication of the drafts also needs owner approval.

## 7. Git and deployment status
- Review work is on branch `compliance/razorpay-review-draft`. It does not deploy: Render auto-deploys only `main`.
- Nothing on `main` was changed in this review.

## 8. Status update (second pass)

- Done on the review branch: session cookie Secure default (code, tested), landing copy corrections, refund and privacy draft corrections, payment-route map (`PAYMENT_ROUTES.md`), Razorpay support inquiry draft (`RAZORPAY_SUPPORT_INQUIRY.md`, not sent).
- Still needed from you: physical address, verified support email and phone, support hours and response time, grievance details if required, live payment-method list, refund process for overpayments, rate-update description, cookie-security deployment confirmation, and a decision on whether to keep the "Deposit in INR" entry points visible while INR creation is paused.
- Still needed from Razorpay: written eligibility for purchased engagement, subcategory confirmation, and whether the individual-proprietor billing label is acceptable.

## 9. Final package for review (third pass)

Ready for your review, in this order:
1. `RAZORPAY_SUPPORT_INQUIRY.md`. Discloses purchased engagement delivered through supplier APIs and asks Razorpay for written eligibility and merchant category. Fill the square-bracket items, then send by the steps in that file. Not sent.
2. `PAYMENT_ROUTES.md`. Note the admin manual INR verify route: it can credit the INR wallet and is not gated by the pause or the auto-credit flag. Decide whether to keep, gate or remove it. Not changed on this branch.
3. `SERVICE_ELIGIBILITY.md`. The decision on whether to keep selling purchased engagement at all is still yours.

Owner inputs still needed before any draft can be published:
- Business address (REQUIRED, not supplied).
- Support email: `arnavsingh98001@gmail.com` was supplied for this review. It differs from the address used in earlier drafts. Confirm which is the support address; the inquiry does not substitute one for the other.
- Support phone `7457945493`: supplied, not verified.
- Support hours, response time, grievance details, refund timeframes, rate-update description, GST status.
- Whether `instasmm.store` is served by this repository's Render service (not verified from here).

Not done, and deliberately so: no Razorpay checkout, no INR auto-credit, no change to secrets, environment variables, database contents or Render settings, no merge to `main`, no deploy.
