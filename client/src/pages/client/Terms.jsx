const SECTIONS = [
  {
    title: '1. Acceptance, Accounts and Security',
    paras: [
      'By creating an account, placing an order or making a deposit, you agree to these Terms of Service. If you do not agree, do not use InstaSMM.',
      'You must give accurate registration information and keep your password and account access secure. You are responsible for activity under your account. Do not share your account or let other people use it. Each account should belong to one person.',
      'You must use InstaSMM in line with applicable laws. If we find that an account is being misused, Section 11 explains what we may do.',
    ],
  },
  {
    title: '2. Service Description and Third-Party Providers',
    paras: [
      'InstaSMM provides social-media engagement services, such as followers, likes and views, through a panel that connects to independent third-party providers (suppliers).',
      'Service availability, delivery speed and results depend on those suppliers and on the social-media platforms themselves. We handle support requests and order disputes under our published policies and applicable law, including where a supplier is involved.',
    ],
  },
  {
    title: '3. Service Descriptions, Estimates and Results',
    paras: [
      'Quantities, delivery speeds, retention estimates and average drop-rate figures are indicative only, unless a specific service explicitly states a guarantee.',
      'Average drop-rate figures are informational. They are not a verified prediction for your order, they may be outdated or unrepresentative, and they are not a guarantee of your result.',
      'Platforms may remove, discount or adjust engagement at any time. Delivery may be delayed, partial or unsuccessful because of supplier availability, platform changes or other factors outside our control.',
      'We do not promise instant completion or guaranteed retention unless a specific service explicitly says so.',
    ],
  },
  {
    title: '4. Drop-Based Services: No Warranty',
    paras: [
      'Drop-based services do not include a warranty, a refill guarantee or guaranteed retention, unless the service description explicitly states otherwise.',
      'A drop-based service is not warrantied because a retention percentage or average drop rate is shown on our website. Average drop-rate information is informational only and does not create a warranty.',
      'Drop-based services without an explicit warranty are not eligible for warranty-based drop restoration.',
    ],
  },
  {
    title: '5. Placing Orders and Your Responsibilities',
    paras: [
      'You must enter the correct profile or post link, the correct service and quantity, and any other required details. Read the service description before you order, including any stated refill or warranty terms.',
      'Some customer-side conditions can affect delivery, for example a private profile, deleted content, a changed username or link, or an account restricted by the platform. We cannot detect every such condition automatically. If you notice one, contact support.',
    ],
  },
  {
    title: '6. Order Statuses and Processing',
    paras: [
      'Your order shows one of these statuses, as reported by our system and the supplier:',
    ],
    list: [
      'Pending: the order has been received and is waiting for the supplier.',
      'In progress: the supplier is delivering the order.',
      'Partial: only part of the quantity has been delivered.',
      'Completed: the supplier reports that the order is complete.',
      'Canceled: the order was stopped (see Section 8 for refund rules).',
      'Failed: the supplier reports that the order could not be delivered. This is reviewed as described in Section 8.',
      'Refunded: a refund has been recorded against the order.',
    ],
    after: [
      'If a supplier refuses an order when it is placed, the order is shown as "Not accepted · refunded" and the amount is returned to your wallet automatically, once (Section 8).',
      'Status updates come from the supplier and may take time to appear. An order is not confirmed as accepted or completed until your account shows that status. In unusual cases where a supplier response is unclear, we hold the order for review rather than re-submitting it.',
    ],
  },
  {
    title: '7. Partial Deliveries',
    paras: [
      'If an order is only partly delivered, the Refund, Deposit & Payment Policy explains how we review it. A partial refund may be considered only after we verify the undelivered portion with the supplier. Partial refunds are not automatic.',
    ],
  },
  {
    title: '8. Refunds and Wallet Balance',
    paras: [
      'The Refund, Deposit & Payment Policy sets out the detailed rules and is part of these Terms. In summary, for each situation:',
    ],
    list: [
      'Supplier rejects an order at placement: the exact amount debited is returned to your wallet automatically, once.',
      'Order fails: we verify the outcome with the supplier. Where compensation is due, it may be a refill (where the service supports it), a replacement, or a partial refund. It is not automatic.',
      'Order is canceled: where we cancel an order and the service supports cancellation, the undelivered portion is returned to your wallet. Otherwise no automatic cancellation refund applies. Once a supplier has accepted an order, we may be unable to cancel it.',
      'Order is partially delivered: see Section 7.',
      'Duplicate or incorrect payment: contact support with transaction evidence. We correct the account only after verifying the transaction against our records.',
      'Payment sent but wallet credit delayed: contact support with your transaction hash. We check the payment before crediting or correcting anything.',
      'Disputed order: raise a support ticket (Section 13). Disputes are reviewed on their own facts.',
      'Refill or other remedy: available only where a service explicitly supports it and refill is enabled on the platform (Section 9).',
    ],
    after: [
      'Wallet balances are used to purchase services and are generally not withdrawable through the website. Refunds are generally credited to your wallet rather than to your original payment method, subject to applicable law and the Refund, Deposit & Payment Policy.',
      'Nothing in these Terms removes any right you have under applicable law, including any right to a refund or correction that cannot be waived.',
    ],
  },
  {
    title: '9. Refills and Warranty Requests',
    paras: [
      'Refill availability depends on the particular service. A service must explicitly support refills, and refill must be available on our platform, before a refill can be requested.',
      'A refill request does not by itself guarantee that the supplier will approve or complete it. Eligible requests are handled according to the service description, the Refund, Deposit & Payment Policy and applicable law.',
    ],
  },
  {
    title: '10. Cryptocurrency Payments, Deposits and Credits',
    paras: [
      'Deposits are made in cryptocurrency. The methods currently offered at checkout are Litecoin (LTC), Tether USD on the BNB Smart Chain (USDT BEP20) and Tether USD on Ethereum (USDT ERC20).',
      'Each invoice shows the address, amount and expiry time. Send the exact amount on the network shown for that invoice. Sending on a different network, or after an invoice has expired, can delay or prevent the credit. If this happens, contact support with your transaction hash.',
      'Your wallet is credited in Indian rupees (INR) at the exchange rate shown on the invoice when it was created. Partial payments are credited as the verified amount arrives, and the invoice shows how much has been received.',
      'Where an INR deposit method is offered, a customer surcharge of 10% is added to the amount you pay. The wallet is credited with the amount before the surcharge, and the total payable is shown before you confirm.',
      'Blockchain network fees are set by the network, not by InstaSMM. Duplicate deposits, incorrect transfers and disputed payments are handled under the Refund, Deposit & Payment Policy.',
    ],
  },
  {
    title: '11. Prohibited Use, Fraud and Abuse',
    paras: [
      'You must not use InstaSMM for unlawful purposes, to harass or abuse others, to make fraudulent payment claims, to manipulate order records or balances, or to exploit our refund or refill processes, for example through false claims.',
      'If we find such conduct, we may refuse or hold orders, pause a claim while it is investigated, or suspend your account. Where a claim is shown to be fraudulent, we may close the account and seek to recover amounts owed. Any action on your account or balance is taken after review and in line with applicable law.',
    ],
  },
  {
    title: '12. Third-Party Platform Rules and Liability',
    paras: [
      'You are responsible for understanding and following the rules of each social-media platform you use. Platforms may restrict accounts or remove engagement, and this can happen regardless of how an order was delivered.',
      'To the extent permitted by applicable law, InstaSMM is not liable for indirect, incidental or consequential losses, and our total liability for a particular order is limited to the amount you paid for that order.',
      'Nothing in these Terms excludes or limits liability that cannot legally be excluded or limited, including liability for fraud. Even where a supplier is involved, we remain responsible for handling your support requests and claims under our published policies.',
    ],
  },
  {
    title: '13. Support and Disputes',
    paras: [
      'Contact us through the Tickets page in your account dashboard (instasmm.store/tickets). Please include your order reference, the relevant link, a clear description of the problem and, where appropriate, evidence such as a screenshot or transaction hash.',
      'Claims without an order reference or evidence may take longer to review or may not be assessed.',
    ],
  },
  {
    title: '14. Changes to These Terms and Related Policies',
    paras: [
      'We may update these Terms from time to time. The updated version applies from the time it is published on this website. Changes do not remove any right you have under applicable consumer protection law.',
      'These Terms are read together with the Refund, Deposit & Payment Policy and the Privacy Policy. If these Terms and the Refund, Deposit & Payment Policy appear to conflict on a refund decision, the Refund, Deposit & Payment Policy applies, subject to applicable law.',
    ],
  },
];

export default function TermsPage() {
  return (
    <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 className="page-title">Terms of Service</h1>

      <div className="stack" style={{ gap: 16, color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.92rem' }}>
        <p>
          These Terms govern your use of InstaSMM (instasmm.store). Please also read our{' '}
          <a href="/refund-policy" style={{ color: 'var(--info)' }}>Refund, Deposit &amp; Payment Policy</a>{' '}
          and our <a href="/privacy" style={{ color: 'var(--info)' }}>Privacy Policy</a>.
        </p>

        {SECTIONS.map((s) => (
          <div key={s.title} style={{ overflowWrap: 'anywhere' }}>
            <p><b style={{ color: 'var(--text)' }}>{s.title}</b></p>
            {s.paras.map((t, i) => <p key={i}>{t}</p>)}
            {s.list && (
              <ul style={{ paddingLeft: 20, margin: '0 0 12px' }}>
                {s.list.map((item) => <li key={item} style={{ marginBottom: 6 }}>{item}</li>)}
              </ul>
            )}
            {s.after && s.after.map((t, i) => <p key={`a${i}`}>{t}</p>)}
          </div>
        ))}
      </div>
    </div>
  );
}
