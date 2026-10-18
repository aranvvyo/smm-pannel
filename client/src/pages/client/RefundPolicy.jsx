const SECTIONS = [
  {
    title: '1. No Deposit Withdrawals',
    body: 'Funds deposited into your InstaSMM wallet are generally not withdrawable. They are intended for purchasing services on InstaSMM. Mistaken or duplicate payments are handled under Section 6. Where applicable law or a payment provider’s rules give you a right to a refund or correction, this policy does not take that right away.',
  },
  {
    title: '2. Partial Refund Policy',
    body: 'A partial refund may be considered only after we verify that a specific, eligible portion of a service failed or was not delivered. Refunds are not guaranteed. Each request is reviewed on its own facts, and any approved amount covers only the verified eligible portion.',
  },
  {
    title: '3. Refill & Warranty Policy',
    body: 'Where a service includes a refill or warranty, eligible claims are handled under that service’s published warranty terms. A refill or replacement does not, by itself, entitle you to a monetary refund.',
  },
  {
    title: '4. Partial Refund Processing Time',
    body: 'Approved partial refunds are processed after review and approval.',
  },
  {
    title: '5. Order Cancellation & Failed Services',
    body: 'If a supplier refuses an order when it is placed, the exact amount debited is returned to your wallet automatically, once. Cancellation is limited. Once an order has been submitted to the supplier, we may be unable to cancel it, and cancellation depends on what the supplier allows. Where we cancel an order and the service supports cancellation, the undelivered portion is returned to your wallet. If a service fails or is not delivered, we verify the outcome with the supplier before deciding on any compensation. Eligible compensation may take the form of a refill, a replacement, or a partial refund, as described in Sections 2 to 4. Automatic refunds are not given for failed or partial orders.',
  },
  {
    title: '6. Incorrect Payments & Duplicate Deposits',
    body: 'If you believe a payment was sent in error or sent twice, contact support with your order ID or transaction reference and valid evidence, such as the transaction hash or payment receipt. We verify the transaction against our records before making any correction.',
  },
  {
    title: '7. Chargebacks & Payment Abuse',
    body: 'If a payment is disputed or reversed, we may investigate and restrict the related account while the investigation is open. Where a claim is demonstrably fraudulent, we may suspend or close the account and seek to recover amounts owed. This section does not limit any legitimate legal right you have to dispute a payment.',
  },
  {
    title: '8. Service-Specific Terms',
    body: 'Delivery times, refill eligibility and warranties depend on each service’s published description. Read the description of a service before you order it.',
  },
  {
    title: '9. Support & Claims',
    body: 'Submit claims through the support ticket system in your dashboard. Include your order ID and relevant evidence, such as a screenshot of the order, the target link, and the start and remaining counts. Claims without an order ID or evidence may take longer to review or may not be assessed.',
  },
  {
    title: '10. Policy Enforcement & Updates',
    body: 'We enforce this policy reasonably and consistently, including declining claims that are not supported by evidence or that breach our Terms of Service. We may update this policy. The updated version applies from the date shown on this page. Nothing in this policy removes rights you have under applicable consumer protection law that cannot be waived.',
  },
];

export default function RefundPolicyPage() {
  return (
    <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 className="page-title">Refund, Deposit &amp; Payment Policy</h1>
      <p className="page-sub">Last updated: 18 October 2026</p>

      <div className="stack" style={{ gap: 16, color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.92rem' }}>
        <p>
          This policy explains how InstaSMM handles deposits, payments, refunds, refills and failed
          orders. It applies together with our{' '}
          <a href="/terms" style={{ color: 'var(--info)' }}>Terms of Service</a> and{' '}
          <a href="/privacy" style={{ color: 'var(--info)' }}>Privacy Policy</a>.
        </p>

        {SECTIONS.map((s) => (
          <p key={s.title} style={{ overflowWrap: 'anywhere' }}>
            <b style={{ color: 'var(--text)' }}>{s.title}</b>
            <br />
            {s.body}
          </p>
        ))}
      </div>
    </div>
  );
}
