# Owner checklist and publication status

## 1. Safe changes ready to implement
- Footer links on public pages (About, Contact, Terms, Privacy, Refund, Payment & Delivery) once the drafts are approved.
- Removing "No-Loss Guarantee", "Instant Delivery" and "24/7 automated" wording from the landing page.
- Correcting the Terms §4 wallet refund statement to match the refund process you approve.
- Correcting the Privacy disclosures (third parties, IP logging, cookie lifetime after verification).

Not yet made. These require your decision first, and they are on this review branch only.

## 2. Draft content awaiting owner approval
- `drafts/REFUND_CANCELLATION.md`
- `drafts/PRIVACY_POLICY.md`
- `drafts/TERMS_AND_CONDITIONS.md`
- `drafts/ABOUT_CONTACT_PAYMENT.md`

## 3. Missing facts preventing publication
- **Physical business address — REQUIRED, OWNER MUST PROVIDE.** Not supplied. Not invented.
- Support email: supplied as arnavsingh98001@gmail.com, not verified. The email on this workspace's account is arnavsingh98002@gmail.com, and the earlier address was also 98002. Please confirm which address is the support address.
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
- Crypto deposit duplicate and underpayment handling not re-verified in this review.
- No customer-facing refund to original payment method exists.

## 6. Go / no-go
**Do not submit this website to Razorpay for merchant review yet.** The blockers are sections 3 and 4 above. Publication of the drafts also needs owner approval.

## 7. Git and deployment status
- Review work is on branch `compliance/razorpay-review-draft`. It does not deploy: Render auto-deploys only `main`.
- Nothing on `main` was changed in this review.
