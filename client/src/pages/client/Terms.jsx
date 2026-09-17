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
          All payments are made via cryptocurrency (LTC, USDT BEP20, USDT ERC20). Deposits are credited in INR based on the prevailing exchange rate. Once credited, wallet balances are non-refundable except at admin discretion.</p>

        <p><b style={{ color: 'var(--text)' }}>5. Order Delivery</b><br />
          Service delivery times vary by provider and are estimates only. InstaSMM does not guarantee exact delivery times. Partial deliveries may occur depending on the service provider.</p>

        <p><b style={{ color: 'var(--text)' }}>6. Prohibited Use</b><br />
          You may not use this service for illegal purposes, to violate the terms of service of any social media platform, or to spam or harass others. Accounts found in violation may be terminated without refund.</p>

        <p><b style={{ color: 'var(--text)' }}>7. Limitation of Liability</b><br />
          InstaSMM shall not be liable for any indirect, incidental, or consequential damages arising from the use of our services.</p>

        <p><b style={{ color: 'var(--text)' }}>8. Changes to Terms</b><br />
          We reserve the right to modify these terms at any time. Continued use of the service constitutes acceptance of any changes.</p>
      </div>
    </div>
  );
}
