# Privacy Policy — DRAFT, OWNER APPROVAL REQUIRED

Written against the code as of commit `6ae50aa`. Items marked REQUIRED must be completed before publication.

## 1. Who we are

InstaSMM (instasmm.store) is operated by Alok Kumar Singh, an individual proprietor. REQUIRED: postal address for data-protection correspondence. Contact: REQUIRED (owner to confirm the support email is working).

## 2. Information we collect

- **Account**: email address, name (if provided), password stored only as a salted scrypt hash.
- **Orders**: the service, quantity, the profile or post link you submit, price paid, status and delivery counts.
- **Wallet and payments**: deposit requests, transaction references, amounts, wallet balance and ledger entries.
- **Support**: tickets and messages you send.
- **Security and technical logs**: IP address and the action taken (for example login attempts, withdrawal actions). Logs are kept in the database.
- **Cookies**: one HttpOnly, SameSite=Strict session cookie to keep you signed in. The cookie lifetime is REQUIRED (owner/engineer to confirm the configured value before publication).
- **Analytics**: none are installed in the code reviewed. REQUIRED: confirm before publication.

## 3. Why we use it and our legal basis

- To create and run your account, process orders, manage your wallet and answer support requests (performance of a contract).
- To prevent fraud and abuse and to secure the service (legitimate interest).
- To keep financial and transaction records as required by law (legal obligation). REQUIRED: legal basis wording to be confirmed by a lawyer under the DPDP Act, 2023 and applicable rules.

## 4. Who receives your data

- **Payment processors**: crypto deposits are handled through Apirone. INR UPI deposits, where offered, through VC Gateway. REQUIRED: confirm which are live for customers.
- **Supplier services**: to fulfil an order we send the service, quantity and the link you provided to the supplier that performs it. The supplier's own privacy practices apply to what it does with that information.
- **Hosting**: the application runs on Render. REQUIRED: confirm the database location and provider.
- We do not sell personal information. REQUIRED: confirm no other sharing (for example with advertisers).

## 5. How long we keep data

- Account data: while the account is active.
- Financial and transaction records: kept as long as required by applicable law. REQUIRED: retention period set by the owner's accountant.
- Security logs: REQUIRED (owner to set the period; no automatic deletion exists in the code today).

## 6. Your requests (access, correction, deletion)

You may ask us to access, correct or delete your data by opening a support ticket. We will delete what we can, except financial and transaction records that must be kept. REQUIRED: response time, and the grievance officer details if required by law.

Note: the application does not yet provide a self-service account deletion option.

## 7. Security and its limits

Passwords are hashed. Sessions use an HttpOnly cookie. Provider API keys are stored in the database and are visible only to admins. Encryption at rest is not implemented in the application. No system is completely secure. REQUIRED: the owner must confirm any security claim before it is published. The phrases "regular security audits" and "encrypted databases" from the earlier policy have not been verified and are omitted here.

## 8. Changes and effective date

REQUIRED (owner): effective date and version.
