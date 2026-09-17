import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast, Icon } from '../../ui.jsx';

export default function Login({ admin = false }) {
  const { login, adminLogin } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const fn = admin ? adminLogin : login;
      const user = await fn(email, password);
      toast(admin ? 'Welcome back, Admin.' : 'Signed in successfully.', 'success');
      nav(admin || user?.role === 'admin' ? '/admin' : '/dashboard');
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <span className="logo" style={{ justifyContent: 'center' }}><span className="logo-mark"><Icon name="logo" size={18} stroke={2} style={{ color: '#fff' }} /></span>InstaSMM</span>
          <h1 className="page-title" style={{ fontSize: '1.5rem', marginTop: 14 }}>
            {admin ? 'Admin Portal' : 'Welcome back'}
          </h1>
          <p className="muted" style={{ fontSize: '0.95rem' }}>
            {admin ? 'Restricted — admin credentials only.' : 'Sign in to continue boosting.'}
          </p>
        </div>

        {admin && (
          <div className="badge badge-warn" style={{ marginBottom: 12 }}>
            <span className="dot" style={{ background: 'var(--warn)' }} /> Authorized personnel only
          </div>
        )}

        <label className="label">Email</label>
        <input className="input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />

        <label className="label">Password</label>
        <div className="pw-shell">
          <input className="input pw-input" type={showPw ? 'text' : 'password'} autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          <button type="button" className="pw-toggle" onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? 'Hide password' : 'Show password'}>
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={17} stroke={1.8} />
          </button>
        </div>

        {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} disabled={busy}>
          {busy ? 'Signing in…' : admin ? 'Sign in to Admin' : 'Sign In'}
        </button>

        <div className="auth-trust">
          <Icon name="lock" size={14} stroke={1.8} /> Protected by secure sessions &mdash; passwords never stored in plain text.
        </div>

        {!admin && (
          <p className="muted" style={{ textAlign: 'center', marginTop: 14, fontSize: '0.92rem' }}>
            New here? <Link to="/signup">Create an account</Link>
          </p>
        )}
        {admin && (
          <p className="muted" style={{ textAlign: 'center', marginTop: 18, fontSize: '0.85rem' }}>
            <Link to="/"><Icon name="arrowLeft" size={14} stroke={2.2} style={{ verticalAlign: '-2px' }} /> Back to site</Link>
          </p>
        )}
      </form>
    </div>
  );
}