export default function PrivacyPage() {
  return (
    <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 className="page-title">Privacy Policy</h1>
      <p className="page-sub">Last updated: September 2025</p>

      <div className="stack" style={{ gap: 16, color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.92rem' }}>
        <p><b style={{ color: 'var(--text)' }}>1. Information We Collect</b><br />
          We collect your email address, name, and usage data (orders, deposits, support tickets) necessary to provide our services. We do not collect unnecessary personal information.</p>

        <p><b style={{ color: 'var(--text)' }}>2. How We Use Your Information</b><br />
          Your information is used solely to operate the platform, process orders, manage your wallet, and communicate with you regarding your account and orders.</p>

        <p><b style={{ color: 'var(--text)' }}>3. Data Storage</b><br />
          Passwords are stored as scrypt hashes. Other account and order data is stored in our hosted database.</p>

        <p><b style={{ color: 'var(--text)' }}>4. Third-Party Sharing</b><br />
          We do not sell your personal information. We share information only with the service providers needed to run the site: a cryptocurrency payment processor (Apirone) for deposits, the supplier services that deliver your orders (the profile link, service and quantity you submit), and our hosting provider.</p>

        <p><b style={{ color: 'var(--text)' }}>5. Cookies</b><br />
          We use HttpOnly, Secure session cookies to keep you signed in. The cookie holds a random token; the server stores only a hash of it. Sessions last up to about 30 days. The server's security log records IP addresses for sign-ins and account actions.</p>

        <p><b style={{ color: 'var(--text)' }}>6. Data Retention</b><br />
          We keep account data while the account exists. There is no self-service account deletion yet; deletion requests are handled manually by the operator.</p>

        <p><b style={{ color: 'var(--text)' }}>7. Security</b><br />
          Passwords are hashed with scrypt, session cookies are HttpOnly, and admin functions require an admin account. No method of transmission over the Internet is completely secure.</p>

        <p><b style={{ color: 'var(--text)' }}>8. Contact</b><br />
          For privacy-related inquiries, please open a support ticket through the platform.</p>
      </div>
    </div>
  );
}
