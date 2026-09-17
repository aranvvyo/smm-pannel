import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast, fmtInr, Icon } from '../../ui.jsx';
import { api } from '../../api.js';

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [todaySpent, setTodaySpent] = useState(null);
  const [pw, setPw] = useState({ new_password: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  // Real ledger aggregate (server-side), shown once — never a fabricated number.
  useState(() => {
    (async () => {
      try {
        const d = await api('/api/wallet');
        setTodaySpent(d.today_spent_inr ?? 0);
      } catch { /* keep null; profile is non-critical */ }
    })();
  });

  if (!user) return null;

  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.new_password.length < 6) { toast('New password must be at least 6 characters.', 'error'); return; }
    if (pw.new_password !== pw.confirm) { toast('Passwords do not match.', 'error'); return; }
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'POST', body: { new_password: pw.new_password, confirm: pw.confirm } });
      toast('Password updated. Please sign in again.', 'success');
      // All sessions were invalidated server-side — force a fresh login.
      window.location.href = '/login';
    } catch (err) {
      toast(err.message || 'Could not update password.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">My Account</h1>
      <p className="page-sub">Your profile and account settings.</p>

      <div className="card" style={{ maxWidth: 520 }}>
        <div className="flex between" style={{ marginBottom: 14 }}>
          <span className="row-label">Email</span>
          <span className="row-value">{user.email}</span>
        </div>
        <div className="divider" />
        <div className="flex between" style={{ marginBottom: 14 }}>
          <span className="row-label">Name</span>
          <span className="row-value">{user.name || '—'}</span>
        </div>
        <div className="divider" />
        <div className="flex between" style={{ marginBottom: 14 }}>
          <span className="row-label">Wallet balance</span>
          <span className="row-value" style={{ color: 'var(--success)' }}>{fmtInr(user.wallet_inr || 0)}</span>
        </div>
        <div className="divider" />
        <div className="flex between">
          <span className="row-label">Today&apos;s spend</span>
          <span className="row-value">{todaySpent == null ? '…' : fmtInr(todaySpent)}</span>
        </div>
      </div>

      {/* Password change — does NOT require the old password (account recovery
          flow). scrypt-hashed server-side; all sessions are revoked so the user
          signs in again with the new password. */}
      <div className="card" style={{ maxWidth: 520 }}>
        <h2 className="card-title"><Icon name="lock" size={16} stroke={2} /> Change password</h2>
        <form onSubmit={changePassword} className="stack">
          <label className="field">
            <span className="field-label">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={pw.new_password}
              onChange={(e) => setPw((s) => ({ ...s, new_password: e.target.value }))}
              placeholder="At least 6 characters"
            />
          </label>
          <label className="field">
            <span className="field-label">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={pw.confirm}
              onChange={(e) => setPw((s) => ({ ...s, confirm: e.target.value }))}
              placeholder="Repeat the new password"
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Update password'}
          </button>
          <p className="faint" style={{ fontSize: '0.8rem' }}>
            Your password is stored scrypt-hashed server-side. After updating, all active
            sessions are logged out and you sign in again with the new password.
          </p>
        </form>
      </div>
    </>
  );
}