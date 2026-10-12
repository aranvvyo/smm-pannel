import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { get } from '../../api.js';
import { useCountUp, Icon } from '../../ui.jsx';

// The 3D hero is lazy-loaded: three.js + React Three Fiber are code-split
// into their own chunk, so the homepage renders fully before any 3D code
// downloads. WebGL/reduced-motion/model-failure fallbacks live in
// components/HeroScene.jsx.
const HeroScene = lazy(() => import('../../components/HeroScene.jsx'));

const CAT_COLORS = {
  Instagram: '#e1306c', YouTube: '#ff0000', TikTok: '#25f4ee', Telegram: '#229ED9',
  Twitter: '#1d9bf0', Facebook: '#1877f2', default: '#10b981',
};

// Platform chips shown in the hero. Each carries its brand tint via --c.
const PLATFORMS = [
  { name: 'Instagram', icon: 'camera', c: '#e1306c' },
  { name: 'YouTube', icon: 'play', c: '#ff4d4d' },
  { name: 'TikTok', icon: 'music', c: '#25f4ee' },
  { name: 'Telegram', icon: 'send', c: '#229ED9' },
  { name: 'Twitter', icon: 'birds', c: '#1d9bf0' },
  { name: 'Facebook', icon: 'thumbsUp', c: '#1877f2' },
];

const BENEFITS = [
  { icon: 'zap', title: 'Instant Delivery', body: 'Automated orders run 24/7 through multiple provider APIs with zero manual work.' },
  { icon: 'wallet', title: 'Secure Wallet', body: 'Pay with Litecoin or USDT (BEP20 / ERC20). Deposits are credited safely and tracked in a transparent ledger.' },
  { icon: 'trendUp', title: 'Best Prices', body: 'Direct provider rates with transparent per-1000 pricing and smart coupon discounts.' },
  { icon: 'shield', title: 'No-Loss Guarantee', body: 'Coupons are engineered so every sale still protects our provider costs.' },
  { icon: 'chart', title: 'Live Tracking', body: 'Watch your order start count, remains and status update in real time.' },
  { icon: 'support', title: 'Super Support', body: 'Built-in ticket system — attach your order ID and talk directly with the team.' },
];

const STEPS = [
  { n: '01', icon: 'user', title: 'Create your account', body: 'Sign up with any email — basic format check, agree to Terms, ready in seconds.' },
  { n: '02', icon: 'deposit', title: 'Top up your wallet', body: 'Pick LTC, USDT BEP20 or USDT ERC20, enter USD, and pay to a generated deposit address.' },
  { n: '03', icon: 'order', title: 'Place an order', body: 'Choose a service, paste your target link, set the quantity and apply a coupon.' },
  { n: '04', icon: 'rocket', title: 'Track delivery live', body: 'Watch start count and remains climb as the provider fulfills your order.' },
];

const PAYMENT_METHODS = [
  { icon: 'coins', name: 'LTC', sub: 'Litecoin network', tag: 'HOT' },
  { icon: 'coins', name: 'USDT (BEP20)', sub: 'Binance Smart Chain' },
  { icon: 'coins', name: 'USDT (ERC20)', sub: 'Ethereum network' },
];

const SECURITY = [
  { icon: 'lock', title: 'Encrypted sessions', body: 'HttpOnly cookie sessions with hashed tokens — credentials never touch the browser.' },
  { icon: 'shield', title: 'No price leakage', body: 'Provider costs and API keys stay server-side. Clients only ever see the sale price.' },
  { icon: 'checkCircle', title: 'Verified crypto', body: 'Every Apirone webhook is token-checked and server-verified against the gateway before any credit; duplicate payments are rejected safely.' },
  { icon: 'eyeOff', title: 'Zero secrets exposed', body: 'No secrets on the frontend, server-side payment routing only.' },
];

const FAQS = [
  { q: 'What is InstaSMM?', a: 'A fully automated SMM panel. You buy followers, likes and views for your profiles, and our system delivers them automatically through multiple provider APIs.' },
  { q: 'How long does delivery take?', a: 'Most orders start within seconds and complete within minutes to hours depending on the service and provider. You can track progress live on the My Orders page.' },
  { q: 'Which payments do you accept?', a: 'We accept Litecoin (LTC) and USDT on BEP20 and ERC20. Deposits are made in USD and credited to your wallet in INR.' },
  { q: 'Do you offer refunds?', a: 'Canceled orders return the full amount to your wallet. Orders already delivered cannot be refunded, though we offer refills for incomplete deliveries where available.' },
  { q: 'Is my data safe?', a: 'Yes. Passwords are hashed with scrypt, sessions are encrypted HttpOnly cookies, and API keys are never exposed to the frontend.' },
  { q: 'Can I cancel an order?', a: 'Cancel is available for PENDING or IN_PROGRESS orders. The amount not yet delivered is credited back to your wallet.' },
];

function Stat({ n, label }) {
  return <div className="hero-stat"><div className="n">{useCountUp(n).toLocaleString()}</div><div className="l">{label}</div></div>;
}

function Faq({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card faq-item">
      <button className="faq-q" onClick={() => setOpen((v) => !v)}>
        <span>{q}</span>
        <span className={`faq-caret ${open ? 'open' : ''}`}><Icon name="chevronDown" size={18} /></span>
      </button>
      {open && <p className="faq-a">{a}</p>}
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ clients: 0, completed: 0, services: 0, orders: 0 });
  const [preview, setPreview] = useState([]);

  useEffect(() => {
    get('/api/landing/stats').then(setStats).catch(() => {});
    get('/api/landing/services').then((d) => setPreview(d.services)).catch(() => {});
  }, []);

  const cta = user ? (user.role === 'admin' ? '/admin' : '/dashboard') : '/signup';
  const iconFor = (name) => {
    const n = (name || '').toLowerCase();
    if (n.includes('insta') && n.includes('video')) return 'play';
    if (n.includes('insta')) return 'users';
    if (n.includes('you')) return 'play';
    if (n.includes('tik')) return 'music';
    if (n.includes('tele')) return 'send';
    if (n.includes('twit')) return 'trendUp';
    if (n.includes('facebook')) return 'users';
    if (n.includes('like') || n.includes('follower')) return 'heart';
    if (n.includes('view')) return 'eye';
    if (n.includes('subscriber')) return 'users';
    return 'zap';
  };

  return (
    <div className="landing-page">
      <nav className="nav landing-nav">
        <div className="container">
          <div className="nav-inner">
            <span className="logo"><span className="logo-mark"><Icon name="logo" size={18} stroke={2} style={{ color: '#fff' }} /></span>InstaSMM</span>
            <div className="nav-links-landing">
              <a href="#services">Services</a>
              <a href="#how-it-works">How It Works</a>
              <a href="#faq">FAQ</a>
              <a href="#support">Support</a>
            </div>
            <div className="flex" style={{ marginLeft: 'auto' }}>
              {user ? (
                <Link className="btn btn-primary btn-sm" to={cta}>Dashboard <Icon name="arrowRight" size={15} stroke={2.4} /></Link>
              ) : (
                <>
                  <Link className="btn btn-ghost btn-sm" to="/login">Sign in</Link>
                  <Link className="btn btn-primary btn-sm" to="/signup">Get Started</Link>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Hero — copy left, 3D scene right (stacked on phones) */}
      <section className="hero container anime-page">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="hero-eyebrow">
              <span className="live-dot" aria-hidden="true" />
              Crypto-powered SMM panel
            </span>
            <h1>
              Grow your pages.<br />
              <span className="grad-text">Pay with crypto.</span>
            </h1>
            <p>
              InstaSMM is a fully automated SMM panel — order followers, likes and views
              in seconds, pay with Litecoin or USDT, and watch delivery happen in real time.
            </p>
            <div className="hero-cta">
              <Link to={cta} className="btn btn-primary btn-lg">Start Boosting <Icon name="rocket" size={17} stroke={1.9} /></Link>
              <Link to="/signup" className="btn btn-outline btn-lg">Create Free Account</Link>
            </div>
            <div className="hero-badges">
              {PLATFORMS.map(({ name, icon, c }) => (
                <span key={name} className="brand-chip" style={{ '--c': c }}>
                  <Icon name={icon} size={14} />
                  {name}
                </span>
              ))}
              <span className="feature-pill"><Icon name="zap" size={14} /> Auto-delivery</span>
            </div>
            <div className="hero-stats">
              <Stat n={stats.services} label="Services" />
              <Stat n={stats.clients} label="Clients" />
              <Stat n={stats.orders} label="Orders" />
              <Stat n={stats.completed} label="Completed" />
            </div>
          </div>
          <Suspense fallback={<div className="hero3d-skeleton" aria-hidden="true" />}>
            <HeroScene />
          </Suspense>
        </div>
      </section>

      {/* Popular services — real data from /api/landing/services */}
      <section className="section container" id="services">
        <div className="section-head">
          <span className="eyebrow">Services</span>
          <h2 className="section-title">Popular services</h2>
          <p className="section-sub">A sample of what is inside — full catalog after login.</p>
        </div>
        {preview.length > 0 ? (
          <div className="grid grid-4 home-grid" style={{ marginTop: 24 }}>
            {preview.map((s) => {
              const c = CAT_COLORS[s.category] || CAT_COLORS.default;
              return (
                <div key={s.id} className="card hoverable service-tile" style={{ '--c': c }}>
                  <div className="flex between" style={{ marginBottom: 10 }}>
                    <span className="svc-icon" style={{ background: c + '1f', border: '1px solid ' + c + '55', color: c }}>
                      <Icon name={iconFor(s.name + s.category)} size={20} stroke={1.6} />
                    </span>
                    <span className="badge badge-muted">{s.category}</span>
                  </div>
                  <b style={{ fontSize: '0.95rem' }}>{s.name}</b>
                  <div className="muted mt" style={{ fontSize: '0.82rem', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span><Icon name="clock" size={13} style={{ verticalAlign: '-2px' }} /> {s.speed || 'Auto'}</span>
                    <span>min {s.min.toLocaleString()}</span>
                    <span><b style={{ color: 'var(--text)' }}>{fmtPrice(s.price_per_1k)}</b> / 1k</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted" style={{ textAlign: 'center', padding: '20px 0' }}>Loading services…</p>
        )}
      </section>

      {/* Benefits */}
      <section className="section container">
        <div className="section-head">
          <span className="eyebrow">Why us</span>
          <h2 className="section-title">Why InstaSMM</h2>
          <p className="section-sub">Everything you need to run your growth on autopilot.</p>
        </div>
        <div className="grid grid-3 home-grid" style={{ marginTop: 24 }}>
          {BENEFITS.map(({ icon, title, body }) => (
            <div key={title} className="card">
              <div className="svc-icon" style={{ marginBottom: 10, color: 'var(--accent-2)', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)' }}>
                <Icon name={icon} size={19} stroke={1.7} />
              </div>
              <b>{title}</b>
              <p className="muted" style={{ fontSize: '0.92rem', marginTop: 4, lineHeight: 1.6 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="section container" id="how-it-works">
        <div className="section-head">
          <span className="eyebrow">Process</span>
          <h2 className="section-title">How it works</h2>
          <p className="section-sub">From sign-up to delivery in four steps.</p>
        </div>
        <div className="grid grid-4 home-grid" style={{ marginTop: 24 }}>
          {STEPS.map(({ n, icon, title, body }) => (
            <div key={n} className="card">
              <div className="steps-n">{n}</div>
              <div className="svc-icon" style={{ margin: '8px 0 10px', color: 'var(--accent)' }}>
                <Icon name={icon} size={19} stroke={1.7} />
              </div>
              <b>{title}</b>
              <p className="muted" style={{ fontSize: '0.88rem', marginTop: 4 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Payments */}
      <section className="section container" id="payments">
        <div className="section-head">
          <span className="eyebrow">Payments</span>
          <h2 className="section-title">Payments</h2>
          <p className="section-sub">Fast crypto deposits, credited to your INR wallet.</p>
        </div>
        <div className="grid grid-3 home-grid" style={{ marginTop: 24, maxWidth: 880, marginLeft: 'auto', marginRight: 'auto' }}>
          {PAYMENT_METHODS.map(({ icon, name, sub, tag }) => (
            <div key={name} className="card">
              <div className="flex between">
                <div className="svc-icon" style={{ color: 'var(--success)' }}><Icon name={icon} size={20} stroke={1.6} /></div>
                {tag && <span className="badge badge-hot">HOT</span>}
              </div>
              <b style={{ display: 'block', marginTop: 8 }}>{name}</b>
              <span className="faint" style={{ fontSize: '0.85rem' }}>{sub}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Security */}
      <section className="section container" id="security">
        <div className="section-head">
          <span className="eyebrow">Security</span>
          <h2 className="section-title">Built secure</h2>
          <p className="section-sub">Serious engineering behind a simple interface.</p>
        </div>
        <div className="grid grid-4 home-grid" style={{ marginTop: 24 }}>
          {SECURITY.map(({ icon, title, body }) => (
            <div key={title} className="card">
              <div className="svc-icon" style={{ marginBottom: 10, color: 'var(--success)' }}><Icon name={icon} size={19} stroke={1.7} /></div>
              <b style={{ fontSize: '0.92rem' }}>{title}</b>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 4 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="section container" id="faq" style={{ maxWidth: 760 }}>
        <div className="section-head">
          <span className="eyebrow">FAQ</span>
          <h2 className="section-title">Frequently asked questions</h2>
        </div>
        <div className="stack" style={{ marginTop: 24, maxWidth: 680, marginLeft: 'auto', marginRight: 'auto' }}>
          {FAQS.map((f) => <Faq key={f.q} {...f} />)}
        </div>
      </section>

      {/* CTA / support */}
      <section className="container" id="support" style={{ padding: '20px 0 48px' }}>
        <div className="card card-gradient cta-card">
          <span className="eyebrow">Support</span>
          <h2 style={{ fontSize: '1.6rem', fontWeight: 900, letterSpacing: '-0.02em' }}>Ready to boost?</h2>
          <p className="muted" style={{ margin: '10px auto 22px', maxWidth: 460 }}>
            Create your account, top up with LTC or USDT, and place your first order in under a minute.
          </p>
          <Link to={cta} className="btn btn-primary btn-lg">Get Started Free <Icon name="arrowRight" size={17} stroke={2} /></Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="site-footer">
        <div className="container">
          <span className="logo" style={{ justifyContent: 'center', marginBottom: 10 }}>
            <span className="logo-mark"><Icon name="logo" size={15} stroke={2} style={{ color: '#fff' }} /></span>
            InstaSMM
          </span>
          <div className="faint">
            Fully automated SMM panel &middot; crypto deposits &middot; &copy; {new Date().getFullYear()} instasmm.store
          </div>
          <div className="flex" style={{ justifyContent: 'center', marginTop: 10, gap: 18, fontSize: '0.9rem' }}>
            <Link to="/terms" className="muted">Terms</Link>
            <Link to="/privacy" className="muted">Privacy</Link>
            <Link to="/login" className="muted">Client login</Link>
            <Link to="/admin/login" className="muted">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function fmtPrice(p) {
  // price_per_1k is a rupee rate per 1000 units (12.5 = ₹12.50/1k).
  const n = Number(p) || 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
