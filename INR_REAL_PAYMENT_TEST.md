# INR deposit: real-payment test checklist (VC Gateway)

Status: automatic crediting is OFF. A customer's payment is credited only by an
admin's manual verification. The provider status probe is read-only and
credits nothing.

## 1. Server environment variables

Set these on the server only. Never commit them, never paste the key into chat.

| Variable | Source | Notes |
|---|---|---|
| `VCGETAWAY_API_KEY` | Provider dashboard | Secret. Server only. |
| `VCGETAWAY_API_URL` | Provider documentation | Must be `https://vcgatewaypro.com/payment_api.php`. Any other host is refused. |
| `VCGETAWAY_UPI_ID` | Provider dashboard | Receiving UPI ID. See the mismatch note below. |
| `VCGETAWAY_WEBHOOK_SECRET` | Provider (only if a webhook exists) | Not used yet. Leave empty. |

The code default for `VCGETAWAY_UPI_ID` is `paytm.s1dw5n5@pty`, the value confirmed for this provider. Setting the variable overrides it. Check the QR in step 2.

Do not change `autoCreditEnabled` in `server/config.js`.

## 2. Create a ₹1 test deposit

1. Restart the server so the variables load.
2. Log in as a real test client account.
3. Request a deposit of ₹1.00. Expected: a pending order, total ₹1.10 (₹1 credit + ₹0.10 surcharge), and an order ID such as `ORD261012ABCDEF`.
4. Scan the QR or open the UPI link. Expected fields: `pa` = your UPI ID, `pn=InstaSMM`, `am=1.10`, `cu=INR`, `tn` = the order ID.
5. Pay exactly ₹1.10. Do not pay any other amount.

## 3. Check what the provider returns (read-only)

On the server, from the project folder, after the payment:

    node scripts/vc-probe.mjs <ORDER_ID> 1.10

The output shows the HTTP status, size, top-level field names and types, and
the status value if it is one of the five documented ones. It never prints the
key or the URL. Copy that output back to the developer. Do not copy anything
else.

## 4. Interpreting the result

- `SUCCESS`, `PENDING`, `FAILED`, `INVALID`, `NOT_FOUND`: recorded. Nothing is credited automatically.
- No documented fields for the order ID or amount: crediting stays blocked. The reply cannot be bound to the order.
- HTTP error, timeout, or non-JSON: treated as unavailable or unverified. Nothing is credited.

## 5. Crediting

Only an admin's manual verification credits the wallet, and it credits the
₹1.00 base credit, never the ₹1.10 total. Automatic crediting stays off until
the provider confirms the response contract (see below).

## 6. Information still needed from the provider before automatic crediting

1. A sample response for a settled, successful payment, with the field names and types.
2. Whether the response echoes the order ID and the amount, and whether the amount is in rupees or paise.
3. Whether `SUCCESS` means settled, and what the provider transaction ID field is, for duplicate protection.
4. Whether the response states the currency.
5. Whether webhooks exist and how they are signed.
6. Which host is authoritative: `vcgatewaypro.com` (documented) or `vcapi.vcstore.site` (the PHP example).
7. Whether the ₹1 minimum applies to the total payable (₹1.10 passes) or the base credit.

## 7. Safety after the test

- Handle any test wallet credit through the normal admin process. Do not edit balances directly in the database.
- Keep `VCGETAWAY_API_KEY` out of logs, screenshots, and git.
