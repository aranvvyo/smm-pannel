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
          All data is stored in encrypted databases on secure servers. We implement industry-standard security measures to protect your information.</p>

        <p><b style={{ color: 'var(--text)' }}>4. Third-Party Sharing</b><br />
          We do not sell or share your personal information with third parties, except as necessary to fulfill orders through our service providers.</p>

        <p><b style={{ color: 'var(--text)' }}>5. Cookies</b><br />
          We use HttpOnly session cookies to maintain your login session. These cookies do not store personal information and expire after approximately 30 days.</p>

        <p><b style={{ color: 'var(--text)' }}>6. Data Retention</b><br />
          We retain your account data as long as your account is active. You may request account deletion by contacting support.</p>

        <p><b style={{ color: 'var(--text)' }}>7. Security</b><br />
          We employ encryption, secure password hashing (scrypt), and regular security audits to protect your data. However, no method of transmission over the Internet is 100% secure.</p>

        <p><b style={{ color: 'var(--text)' }}>8. Contact</b><br />
          For privacy-related inquiries, please open a support ticket through the platform.</p>
      </div>
    </div>
  );
}
