# Privacy Policy — DRAFT, OWNER APPROVAL REQUIRED

Written against the code as of commit `6ae50aa`. Items marked REQUIRED must be completed before publication.

## 1. Who we are

InstaSMM (instasmm.store) is operated by Alok Kumar Singh, an individual proprietor. REQUIRED: postal address for data-protection correspondence. Contact: REQUIRED (owner to confirm the support email is working).

## 2. Information we collect

- **Account**: email address, name (if provided), password stored only as a salted scrypt hash.
- **Orders**: the service, quantity, the profile or post link you submit, price paid, status and delivery counts.
- **Wallet and payments**: deposit requests, transaction references, amounts, wallet balance and ledger entries.
- **Support**: tickets and messages you send.
- **Security and technical logs**: the security log records the IP address (or "system") with each login attempt, failed login, withdrawal action and similar event. Each session record also stores the IP address it was created from. Logs are kept in the database; no automatic deletion exists today (see section 5).
- **Cookies**: one HttpOnly, SameSite=Strict session cookie named `instasmm_session`. It keeps you signed in for up to 30 days by default. The cookie is marked Secure (sent over HTTPS only) once the change on the review branch is deployed. REQUIRED: owner to confirm the deployed setting before publication.
- **Analytics and advertising**: no analytics or advertising scripts are loaded by the application code reviewed. REQUIRED: owner or engineer to confirm the live site, including any hosting-level tools, before publication.

## 3. Why we use it and our legal basis

- To create and run your account, process orders, manage your wallet and answer support requests (performance of a contract).
- To prevent fraud and abuse and to secure the service (legitimate interest).
- To keep financial and transaction records as required by law (legal obligation). REQUIRED: legal basis wording to be confirmed by a lawyer under the DPDP Act, 2023 and applicable rules.

## 4. Who receives your data

- **Crypto payment processor (Apirone)**: when you deposit crypto, an invoice is created with the processor, and the processor reports payment status for that invoice back to us. The processor's own terms and privacy practices also apply.
- **INR payment gateway (VC Gateway)**: code for INR (UPI) deposits exists but is not open to customers today. If it is enabled, the payment details needed to match your deposit are shared with it. REQUIRED: confirm before publication.
- **Supplier services**: to fulfil an order we send the service, quantity and the link you provided to the third-party supplier that performs it. The supplier's own privacy practices apply to what it does with that information. Suppliers are not named in this policy. REQUIRED (owner): decide whether to name them.
- **Hosting and database**: the application is hosted on Render. Production uses a PostgreSQL database. REQUIRED: confirm the hosting provider's data location and the database provider.
- We do not sell personal information. We do not share it with advertisers. REQUIRED: confirm both statements before publication.

## 5. How long we keep data

- Account data: while the account is active.
- Financial and transaction records: kept as long as required by applicable law. REQUIRED: retention period set by the owner's accountant.
- Security logs: REQUIRED (owner to set the period; no automatic deletion exists in the code today).

## 6. Your requests (access, correction, deletion)

You may ask us to access, correct or delete your data by opening a support ticket. We will delete what we can, except financial and transaction records that must be kept. REQUIRED: response time, and the grievance officer details if required by law.

Note: the application does not yet provide a self-service account deletion option.

## 7. Security and its limits

Passwords are hashed with scrypt. Session tokens are stored only as hashes. The session cookie is HttpOnly and SameSite=Strict. Provider and payment API credentials are stored in the database and are visible only to admins. Encryption at rest is not implemented in the application. No system is completely secure. REQUIRED: the owner must confirm any security claim before it is published. The phrases "regular security audits" and "encrypted databases" from the earlier policy have not been verified and are omitted here.

## 8. Changes and effective date

REQUIRED (owner): effective date and version.
