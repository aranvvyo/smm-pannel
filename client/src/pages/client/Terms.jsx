export default function TermsPage() {
  return (
    <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 className="page-title">Terms of Service</h1>
      <p className="page-sub">Last updated: September 2025</p>

      <div className="stack" style={{ gap: 16, color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.92rem' }}>
        <p><b style={{ color: 'var(--text)' }}>1. Acceptance of Terms</b><br />
          By accessing or using InstaSMM (instasmm.store), you agree to be bound by these Terms of Service. If you do not agree, do not use the service.</p>

        <p><b style={{ color: 'var(--text)' }}>2. Service Description</b><br />
          InstaSMM provides a social media marketing panel that allows users to purchase engagement services such as followers, likes, views, and other social media metrics for various platforms.</p>

        <p><b style={{ color: 'var(--text)' }}>3. Account Registration</b><br />
          You must provide accurate information when creating an account. You are responsible for maintaining the security of your account credentials. One account per user.</p>

        <p><b style={{ color: 'var(--text)' }}>4. Payments</b><br />
          All payments are made via cryptocurrency (LTC, USDT BEP20, USDT ERC20). Deposits are credited in INR based on the prevailing exchange rate. Refunds are credited to your wallet, not to the original payment method. If the supplier refuses an order, the amount is refunded to your wallet automatically, once. Other refunds (for example, cancelled or partly delivered orders) are decided by the operator. Wallet balances cannot be withdrawn through the site.</p>

        <p><b style={{ color: 'var(--text)' }}>5. Order Delivery</b><br />
          Delivery times are estimates only. They depend on the service provider, provider availability, order volume and platform conditions, and they may change without notice. A delay on its own is not a reason for a refund. Orders may be delivered in part, slowly, or not at all, and InstaSMM does not promise that every order will be delivered instantly or successfully. See sections 9 to 12 for further disclaimers and for how to contact support.</p>

        <p><b style={{ color: 'var(--text)' }}>6. Prohibited Use</b><br />
          You may not use this service for illegal purposes, to violate the terms of service of any social media platform, or to spam or harass others. Accounts found in violation may be terminated. Any refund for such an account is decided by the operator.</p>

        <p><b style={{ color: 'var(--text)' }}>7. Limitation of Liability</b><br />
          InstaSMM shall not be liable for any indirect, incidental, or consequential damages arising from the use of our services. Nothing in these terms excludes or limits any liability or right that cannot be excluded under applicable law.</p>

        <p><b style={{ color: 'var(--text)' }}>8. Changes to Terms</b><br />
          We reserve the right to modify these terms at any time. Continued use of the service constitutes acceptance of any changes.</p>

        <p><b style={{ color: 'var(--text)' }}>9. Service Disclaimers</b><br />
          Quantities, delivery speeds, retention rates and drop percentages are estimates, unless a specific service explicitly states otherwise in its description. Any average drop or retention percentage shown on the site is indicative only and is not a guaranteed outcome for your account.<br /><br />
          Social media platforms may change their algorithms, introduce security measures, restrict features, or enforce their policies. Any of these may affect delivery and how long engagement remains. Engagement may be removed, discounted or adjusted by the platform at any time. This section does not change a specific service guarantee that is stated in the description of that service on the site. Where a service is marked as supporting refill, InstaSMM staff may ask the provider for a refill; this is not available for every service and is not a guarantee.</p>

        <p><b style={{ color: 'var(--text)' }}>10. Orders, Information and Support</b><br />
          Accurate order information: you must provide the correct profile or post link, quantity and service for each order. Incorrect information can cause an order to fail or to be delivered to the wrong account or content. Check your details before you confirm an order.<br /><br />
          Order processing and delays: orders are sent to the provider after your wallet balance has been reserved. Processing can be delayed or interrupted by provider availability, maintenance or high demand. An order that the provider has not confirmed shows as "Verifying" while it is checked, and it is not refunded or confirmed until the check is complete.<br /><br />
          Missing or partial delivery: if an order is missing or partly delivered, open a support ticket from the Tickets page of your account. Include the order reference, the link you ordered for and any evidence, such as screenshots. The order will be reviewed under the refund rules in section 4. Nothing in these terms removes any right you have under applicable law.</p>

        <p><b style={{ color: 'var(--text)' }}>11. Third-Party Service Providers</b><br />
          Orders may be fulfilled by third-party service providers. Your profile link, the service you chose and the quantity are sent to the provider that fulfils the order. Providers operate their own systems, so their results are not guaranteed. InstaSMM still handles support requests and order disputes itself, under these terms, its refund rules and applicable law.</p>

        <p><b style={{ color: 'var(--text)' }}>12. Platform Rules and Customer Responsibility</b><br />
          You are responsible for understanding and following the rules of each social media platform on which you use the service. InstaSMM cannot guarantee that your accounts will be free of platform restrictions, penalties or removal of engagement. You are responsible for the accounts and content you ask us to deliver to.</p>
      </div>
    </div>
  );
}
