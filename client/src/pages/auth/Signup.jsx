import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast, Icon } from '../../ui.jsx';

export default function Signup() {
  const { register } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', terms: false });
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!form.terms) { setErr('You must accept the Terms & Conditions to continue.'); return; }
    setBusy(true);
    try {
      await register(form);
      toast('Account created. Welcome to InstaSMM!', 'success');
      nav('/dashboard');
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
          <h1 className="page-title" style={{ fontSize: '1.5rem', marginTop: 14 }}>Create your account</h1>
          <p className="muted" style={{ fontSize: '0.95rem' }}>Free to join — pay only for what you order.</p>
        </div>

        <label className="label">Name <span className="faint">(optional)</span></label>
        <input className="input" value={form.name} onChange={set('name')} placeholder="Your name" autoComplete="name" />

        <label className="label">Email</label>
        <input className="input" type="email" value={form.email} onChange={set('email')}
          placeholder="you@example.com" autoComplete="username" required />

        <label className="label">Password</label>
        <div className="pw-shell">
          <input className="input pw-input" type={showPw ? 'text' : 'password'} value={form.password} onChange={set('password')}
            placeholder="Min 6 characters" autoComplete="new-password" required />
          <button type="button" className="pw-toggle" onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? 'Hide password' : 'Show password'}>
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={17} stroke={1.8} />
          </button>
        </div>

        <label className="label">Confirm password</label>
        <div className="pw-shell">
          <input className="input pw-input" type={showPw ? 'text' : 'password'} value={form.confirm} onChange={set('confirm')}
            placeholder="Repeat password" autoComplete="new-password" required />
          <button type="button" className="pw-toggle" onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? 'Hide password' : 'Show password'}>
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={17} stroke={1.8} />
          </button>
        </div>

        <label className="flex" style={{ marginTop: 16, fontSize: '0.92rem', color: 'var(--muted)', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={form.terms} onChange={set('terms')} style={{ marginTop: 3 }} />
          <span>I have read and agree to the <Link to="/terms">Terms & Conditions</Link> and <Link to="/privacy">Privacy Policy</Link>.</span>
        </label>

        {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} disabled={busy}>
          {busy ? 'Creating account…' : 'Create Free Account'}
        </button>

        <p className="muted" style={{ textAlign: 'center', marginTop: 18, fontSize: '0.92rem' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}