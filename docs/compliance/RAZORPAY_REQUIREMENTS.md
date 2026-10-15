# Razorpay and applicable requirements — findings

Status: research summary. Confirm with Razorpay in writing before relying on it. Not legal advice.

Sources checked (2026-10-13):
- Razorpay Partner/Merchant Terms, Schedule II "Prohibited products and services": https://razorpay.com/s/terms/partners/
- Razorpay Terms: https://razorpay.com/terms/
- Razorpay compliance guidance: https://razorpay.com/blog/payment-gateway-compliance/
- Razorpay documentation: https://razorpay.com/docs/

## A. Explicit payment-provider requirements (quoted from the Terms)

1. Terms §2.11: the platform may not be used "for any purpose that is unlawful, illegal, fraudulent".
2. Terms §14.7(vi): the merchant may not "accept transactions relating to goods or services that fall outside the approved description". This makes the approved business description binding. The clause itself does not say what notice is required for a change; that must be confirmed with Razorpay.
3. Terms §14.10: the merchant may not use the services "for the sale, promotion, facilitation, or acceptance of payments related to" a list of restricted items. Read the full clause before accepting payments.
4. Terms §14.5 and §14.8: disputes about non-delivery, delay or quality are the merchant's responsibility, and so is "all risk associated with the sale and delivery".
5. Terms, Part B, Part I, Clause 2.1: chargeback liability "solely rests with" the merchant.
6. Schedule II, "Prohibited products and services" (partner terms). The list includes "Bulk marketing tools which include email lists, Software, or other products", "Intangible goods and services… at the discretion of the Partner Bank or Acquiring Bank", and "Businesses in legally ambiguous areas". The list is "subject to additions/changes by Razorpay, without any prior intimation".
7. Schedule II does not list social-media followers, likes or views by name. It does not state that such services are permitted. Eligibility is therefore unresolved. Razorpay must confirm it in writing.

## B. Applicable Indian requirements (for the owner's accountant or lawyer to confirm)

- Consumer Protection Act, 2019, and the E-Commerce Rules, 2020. These cover disclosure of seller identity, grievance redressal and refund information for e-commerce sales. Applicability to a service sold to individual consumers should be confirmed.
- Information Technology Act, 2000, and the reasonable-security-practices rules. These apply to personal data handling, including the Privacy Policy claims.
- Digital Personal Data Protection Act, 2023. Commencement and rules should be checked as of the date of publication. The owner's obligations as a data fiduciary need professional review.
- GST: registration status is not confirmed. Do not state that GST applies or does not apply. See the owner checklist.
- Platform terms of the social-media services sold (e.g., Instagram, YouTube, TikTok). Buying engagement may breach them. This is a legal and reputational risk, not a Razorpay rule. Confirm with a lawyer before publication.

## C. Recommended trust and usability improvements

- Separate About, Contact, Terms, Privacy, Refund & Cancellation, and Payment & Delivery pages, linked from a footer on every public page, including before checkout.
- Show the proprietor name, a working support email, and a physical address once supplied.
- State the currency (INR) and show the final amount before payment.
- Remove "No-Loss Guarantee", "Instant Delivery" and "24/7 automated" phrasing that implies guaranteed outcomes.

## D. Items needing confirmation from Razorpay, an accountant, or a lawyer

1. Whether Razorpay accepts payments for purchased social-media engagement (followers, likes, views, subscribers). Get written confirmation before any integration.
2. Whether "Ad and Marketing" (the owner's chosen subcategory) matches the actual service description. Razorpay assigns the subcategory from the approved description.
3. Whether an individual proprietor can use the proposed business name "Instasmm" as the billing label. Confirm with Razorpay.
4. Grievance officer requirements under the Consumer Protection and E-Commerce rules, and the required contact details.
5. GST treatment of the wallet, deposits and order charges.
6. Refund-to-original-method handling for card or UPI payments, if Razorpay is integrated.
7. Chargeback handling and the dispute timelines Razorpay requires.
