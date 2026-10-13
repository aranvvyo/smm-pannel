# Service eligibility — catalogue concerns

Scope: the product as described in the code and landing copy. This is an engineering reading, not a Razorpay ruling. Nothing here changes the catalogue. No service has been renamed or hidden.

## What the product sells

Automated purchases of social-media metrics for a customer's own profiles, fulfilled by third-party supplier APIs:

- Followers, likes, views, subscribers, and similar metrics across platforms.
- The customer submits a profile link, a quantity and a service. The supplier performs the engagement. InstaSMM does not perform it.
- Delivery is determined by the supplier, and the start count, remains and status are passed back.

## Concerns

| Concern | Basis | Action |
|---|---|---|
| Engagement is purchased artificially rather than earned. The original landing copy sold it as growth ("order followers… in seconds"). | Original landing copy (corrected on the review branch). | Describe it as what it is: automated delivery of the purchased metric. Do not claim organic growth, real audiences or authorised platform access. |
| Platform terms. Most social platforms prohibit buying fake engagement. | Third-party terms, not in this repository. | Lawyer to review before publication. Customers should be told they are responsible for their accounts. |
| Razorpay Terms §14.7(vi) and §14.10: payment only for the approved description. | Razorpay Terms. | Obtain written eligibility for "purchased social-media engagement" before any Razorpay integration. |
| Subcategory "Ad and Marketing" may not match the service. | Owner-supplied subcategory. | Confirm with Razorpay. |
| Supplier outcome not guaranteed (partial, cancelled or slow delivery). | Code: partial, cancel and refill paths; supplier-dependent. | Remove "guaranteed" phrasing. Explain partial and failed delivery. |
| Mixed categories: services not verified individually. | The catalogue is imported from supplier lists and was not audited item by item in this review. | The owner should review every active service before any Razorpay submission. |

## Decision required from the owner

1. Decide whether the business continues to sell purchased engagement at all, given that Razorpay eligibility is unresolved.
2. If yes: obtain Razorpay's written answer before enabling Razorpay checkout.
3. If no: pause sales of purchased engagement and rebuild the catalogue around services that are genuinely delivered by people or offered as tools. This is a business decision, not a wording change, and it should not be attempted by renaming services.

Until those decisions are made, **do not submit this website to Razorpay as a merchant application**.
