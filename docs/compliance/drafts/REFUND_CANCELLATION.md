# Refund & Cancellation Policy — DRAFT, OWNER APPROVAL REQUIRED

Do not publish until the owner approves every section and the items marked REQUIRED are filled in.

## 1. What this policy covers

This policy explains how money moves when an order or deposit does not go as expected. InstaSMM credits and debits an INR wallet. Refunds are wallet credits unless stated otherwise.

## 2. Wallet credit is not a refund to your original payment method

- A **wallet credit** adds money to your InstaSMM balance. You can use it to place orders.
- A **refund to the original payment method** returns money to the account or wallet you paid from. InstaSMM does not currently offer this for crypto deposits. For other payment methods it is available only if the owner confirms the process in writing (see REQUIRED below).

## 3. Orders

| Situation | What happens |
|---|---|
| The supplier **definitively refuses** the order (for example, insufficient supplier balance or an invalid link). | Your order is marked "Not accepted". The amount is returned to your wallet once, and any coupon use is released. |
| The order is **accepted** and then fails, is cancelled, or is partly delivered. | The undelivered portion may be credited to your wallet when the order is cancelled by the admin and the service supports it. The delivered portion is not refunded. |
| The order is **held** because the supplier's answer was unclear (a timeout or an error). | The order shows "Verifying". It is **not** refunded automatically, because the supplier may already have accepted it. An admin checks with the supplier and then either confirms the order or refunds it once. |
| You **ask for a pending order to be cancelled**. | There is no self-service cancel button. Ask support with the order reference. An admin decides, and can cancel only if the supplier allows it. If the cancellation goes through, the undelivered amount is credited to your wallet. |

REQUIRED (owner): typical timeframe for a verifying order to be resolved; whether the owner commits to a maximum period.

## 4. Deposits

Verified against the crypto deposit code (`server/lib/apirone.js`, `server/routes/webhooks.js`, `creditDeposit`):

- **Crypto deposits are credited in steps.** Each payment is checked with the payment processor before anything is credited. The wallet is credited for the amount actually received, in INR at the exchange rate in effect when that amount is credited. A deposit that is only partly paid shows "in progress" and is credited for what has arrived. It is marked confirmed once the full invoice amount is received.
- **Each amount is credited once.** Repeated notifications from the processor do not credit the same funds twice.
- **Overpayment.** The wallet is credited only up to the invoice amount. Any excess is **not** credited automatically. An admin reviews it. How any excess is returned is REQUIRED (owner decision).
- **Payment after the invoice has expired.** It is **not** credited automatically. An admin verifies it manually before any credit is made.
- **Two separate invoices paid for the same order.** Each invoice is credited for its own received funds. Neither is refunded automatically. Contact support with both transaction references. REQUIRED (owner): how such a case is returned.
- **Failed or expired deposits** are never credited automatically.
- **INR (UPI) deposits** are currently not open to customers: the code pauses new INR deposits by default and the payment-gateway connection is not active. This section applies only once the owner enables INR deposits and the gateway is connected. REQUIRED (owner): the INR refund process at that time.

REQUIRED (owner): the crypto refund route and network for any excess or duplicate funds returned manually, and whether that is offered at all.

## 5. Delivery delays and quality issues

Delivery times depend on the supplier and are estimates only. A delay is not a refund reason by itself. Contact support if an order is not progressing after the stated estimate. If a supplier fails to deliver an accepted order, the matter is reviewed case by case.

## 6. How to request a refund or raise a complaint

1. Open a support ticket from your account (Tickets page) with the order reference and the link you ordered for.
2. Include a description of the problem and any screenshots.
3. Email: REQUIRED — support email to be confirmed by the owner (proposed: arnavsingh98001@gmail.com, not yet verified).
4. Response time: REQUIRED (owner). Escalation contact: REQUIRED (owner).

## 7. Things this policy does not do

- It does not remove any right you have under applicable consumer law. Where the law gives you a right to a refund, this policy does not take it away.
- It does not promise automatic refunds that the system cannot perform. Refunds on verifying orders are always handled by an admin.

## 8. Changes and effective date

REQUIRED (owner): effective date and version.
