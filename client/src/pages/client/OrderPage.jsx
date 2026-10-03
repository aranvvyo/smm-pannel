import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../../api.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast, fmtInr, StatusBadge, Icon, Empty } from '../../ui.jsx';

const VALID_ICONS = new Set(['camera', 'play', 'thumbsUp', 'birds', 'send', 'music', 'sparkles', 'zap', 'users', 'eye', 'heart', 'package']);

export default function OrderPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();

  const [cats, setCats] = useState([]);
  const [catId, setCatId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [svc, setSvc] = useState(null);
  const [link, setLink] = useState('');
  const [qty, setQty] = useState('');
  const [coupon, setCoupon] = useState('');
  const [search, setSearch] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [err, setErr] = useState('');
  const [providerConfigured, setProviderConfigured] = useState(null); // null = loading
  const [extras, setExtras] = useState({ comments: '', runs: '', interval: '' });
  const deb = useRef(null);

  useEffect(() => {
    get('/api/services').then((d) => {
      setCats(d.categories);
      setProviderConfigured(d.provider_configured);
    }).catch(() => {});
  }, []);

  const allServices = useMemo(
    () => cats.flatMap((c) => c.services.map((s) => ({ ...s, category_name: c.name, category_icon: c.icon }))),
    [cats]
  );

  const services = useMemo(() => {
    const base = catId ? allServices.filter((s) => s.category_id === Number(catId)) : allServices;
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((s) => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
  }, [allServices, catId, search]);

  const selectService = (id) => {
    setServiceId(id);
    const found = allServices.find((s) => s.id === Number(id));
    setSvc(found || null);
    if (found && !catId) setCatId(found.category_id);
    setQuote(null);
  };

  // Category change: refresh the service list immediately and clear any
  // selected service — it may not belong to the new category, so the
  // category and service selections always stay in sync.
  const changeCategory = (id) => {
    setCatId(id);
    setServiceId('');
    setSvc(null);
    setQuote(null);
  };

  const runQuote = async () => {
    if (!serviceId || !qty) return;
    setErr(''); setQuoteBusy(true);
    try {
      const q = await post('/api/quote', { serviceId: Number(serviceId), quantity: Number(qty), coupon_code: coupon.trim() || null });
      setQuote(q);
    } catch (x) { setQuote(null); setErr(x.message); }
    finally { setQuoteBusy(false); }
  };

  // Live quote whenever service/qty/coupon change (debounced).
  useEffect(() => {
    clearTimeout(deb.current);
    if (!serviceId || !qty || Number(qty) <= 0) { setQuote(null); return; }
    deb.current = setTimeout(runQuote, 450);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, qty, coupon]);

  const place = async (e) => {
    e.preventDefault();
    if (!svc || !link.trim() || !qty) { setErr('Choose a service, target link and quantity.'); return; }
    setErr(''); setPlacing(true);
    // Type-specific extras travel with the order (e.g. Comments services take
    // a per-post URL + count; Paged/Runs services take runs + interval).
    const extrasPayload = {};
    if (svc?.type === 'Comments') extrasPayload.comments = extras.comments.trim();
    if (svc?.type === 'Mentions') extrasPayload.comments = extras.comments.trim();
    if (svc?.type === 'Paged' || /runs?/i.test(svc?.type || '')) {
      extrasPayload.runs = extras.runs;
      extrasPayload.interval = extras.interval;
    }
    try {
      const d = await post('/api/orders', {
        serviceId: Number(serviceId), link, quantity: Number(qty), coupon_code: coupon.trim() || null,
        ...extrasPayload,
      });
      setPlaced(d.order);
      toast('Order placed', 'success');
    } catch (x) {
      if (x.status === 402) {
        toast('Insufficient balance — deposit to continue.', 'warn');
        nav('/deposit');
      } else if (x.status === 502 && x.code === 'PROVIDER_ERROR') {
        setErr(x.message);
        toast('Provider rejected the order — nothing was charged.', 'error');
      } else {
        setErr(x.message);
      }
    } finally { setPlacing(false); }
  };

  const q = quote;
  const preCoupon = q?.price ?? 0;
  const discount = q?.discount ?? 0;
  const finalPrice = q?.final ?? 0;

  if (placed) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center', padding: 28 }}>
        <div className="success-hero"><Icon name="checkCircle" size={44} stroke={1.3} /></div>
        <h2 className="page-title" style={{ justifyContent: 'center' }}>Order placed!</h2>
        <p className="muted">Your order <span className="code">{placed.order_ref}</span> is <StatusBadge status={placed.status} />.
          The system is already working on it.</p>
        <div className="card" style={{ margin: '18px auto 0', textAlign: 'left' }}>
          <div className="flex between"><span className="row-label">Service</span><span className="row-value">{placed.service_name}</span></div>
          <div className="flex between mt"><span className="row-label">Quantity</span><span className="row-value">{placed.quantity.toLocaleString()}</span></div>
          <div className="flex between mt"><span className="row-label">Link</span><span className="row-value inline-code" style={{ maxWidth: '55%', textAlign: 'right' }}>{placed.link}</span></div>
          {placed.discount_inr > 0 && (
            <div className="flex between mt"><span className="row-label">Discount</span><span className="row-value" style={{ color: 'var(--success)' }}>−{fmtInr(placed.discount_inr)}</span></div>
          )}
          <div className="divider" />
          <div className="flex between"><span className="row-label">Charged</span><span className="card-value" style={{ fontSize: '1.4rem' }}>{fmtInr(placed.price_inr)}</span></div>
        </div>
        <div className="flex" style={{ justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
          <Link to="/orders" className="btn btn-outline"><Icon name="package" size={15} /> Track orders</Link>
          <Link to="/order" className="btn btn-primary"><Icon name="plus" size={15} /> Place another</Link>
        </div>
        <div className="faint" style={{ marginTop: 16, fontSize: '0.85rem' }}>
          Balance after order: <b style={{ color: 'var(--text)' }}>{fmtInr(user.wallet_inr - placed.price_inr)}</b>
        </div>
      </div>
    );
  }

  const showCategory = catId ? cats.find((c) => c.id === Number(catId)) : null;

  return (
    <>
      <h1 className="page-title">New Order</h1>
      <p className="page-sub">Pick a service, drop your target link, and let the machine do the rest.</p>

      {/* No provider configured — the catalog is empty and ordering is disabled.
          We never fabricate a demo/fake provider for production users. */}
      {providerConfigured === false && (
        <div className="field-error" style={{ maxWidth: 700, padding: '14px 16px', marginBottom: 14 }}>
          <Icon name="alert" size={16} />
          <b style={{ fontWeight: 700 }}>Provider not configured.</b>{' '}
          <span className="muted">No services are available yet — please check back shortly or contact support.</span>
        </div>
      )}

      <form onSubmit={place} className="card" style={{ maxWidth: 700 }}>
        {/* Category picker — one compact dropdown. A native select gives
            mobile users the OS picker (usable on Android + desktop),
            reveals options only when opened, and scrolls natively when
            there are many categories — the page never grows with the
            catalog. */}
        <label className="label" htmlFor="cat-select">Category</label>
        {cats.length > 0 ? (
          <div className="select-shell">
            <span className="select-shell-icon" aria-hidden="true">
              <Icon name={showCategory && VALID_ICONS.has(showCategory.icon) ? showCategory.icon : 'layers'} size={16} />
            </span>
            <select id="cat-select" className="select-shell-input" value={catId} onChange={(e) => changeCategory(e.target.value)}>
              <option value="">All categories · {allServices.length.toLocaleString()} services</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.services.length.toLocaleString()} services</option>
              ))}
            </select>
            <span className="select-shell-caret" aria-hidden="true">
              <Icon name="chevronDown" size={16} />
            </span>
          </div>
        ) : providerConfigured ? (
          <p className="faint" style={{ fontSize: '0.9rem' }}>Loading categories…</p>
        ) : (
          <Empty icon="package" text="No services available — provider not configured." />
        )}

        {/* Service search */}
        <label className="label">Search services</label>
        <div className="input-shell">
          <Icon name="search" size={16} style={{ color: 'var(--faint)' }} />
          <input className="input-inner" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. Instagram followers" />
        </div>

        <label className="label">Service</label>
        <select className="select" value={serviceId} onChange={(e) => selectService(e.target.value)}>
          <option value="">{services.length === 0 ? '— No matching services —' : '— Select service —'}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {fmtInr(s.price_per_1k * 100)} / 1k · min {s.min.toLocaleString()}</option>
          ))}
        </select>
        {svc && (
          <div className="svc-mini-card">
            <div>
              <div className="row-label mb">Price / 1000</div>
              <b style={{ fontSize: '1.25rem', color: 'var(--accent-2)' }}>{fmtInr(svc.price_per_1k * 100)}</b>
            </div>
            <div className="svc-mini-stat"><span className="row-label">Min</span><b>{svc.min.toLocaleString()}</b></div>
            <div className="svc-mini-stat"><span className="row-label">Max</span><b>{svc.max.toLocaleString()}</b></div>
            <div className="svc-mini-stat"><span className="row-label">Speed</span><b style={{ fontSize: '0.82rem' }}>{svc.speed_hint || 'Auto'}</b></div>
            {svc.type && svc.type !== 'Default' && (
              <div className="svc-mini-stat"><span className="row-label">Type</span><b style={{ fontSize: '0.82rem' }}>{svc.type}</b></div>
            )}
          </div>
        )}

        <label className="label">Target link</label>
        <input className="input" value={link} onChange={(e) => setLink(e.target.value)}
          placeholder="https://instagram.com/yourpage — or any public profile/URL" />

        <label className="label">Quantity</label>
        <div className="flex">
          <input className="input" type="number" min={svc?.min || 1} max={svc?.max}
            value={qty} onChange={(e) => setQty(e.target.value)} placeholder={svc ? `Between ${svc.min} and ${svc.max.toLocaleString()}` : 'Quantity'} />
        </div>
        {svc && qty && (Number(qty) < svc.min || Number(qty) > svc.max) && (
          <div className="field-error"><Icon name="alert" size={14} /> Quantity must be between {svc.min.toLocaleString()} and {svc.max.toLocaleString()}.</div>
        )}

        {/* Type-specific extras — only shown for services whose provider type
            needs them. The values are passed straight to the upstream adapter. */}
        {svc?.type === 'Comments' && (
          <label className="label">Comment (paste the text to drop)</label>
        )}
        {svc?.type === 'Comments' && (
          <textarea className="input" rows={3} value={extras.comments}
            onChange={(e) => setExtras((s) => ({ ...s, comments: e.target.value }))}
            placeholder="The comment text is delivered with each view." />
        )}
        {svc?.type === 'Paged' && (
          <div className="stack">
            <label className="label">Runs</label>
            <input className="input" type="number" min={1} value={extras.runs}
              onChange={(e) => setExtras((s) => ({ ...s, runs: e.target.value }))}
              placeholder="How many runs to deliver" />
            <label className="label">Interval (minutes)</label>
            <input className="input" type="number" min={1} value={extras.interval}
              onChange={(e) => setExtras((s) => ({ ...s, interval: e.target.value }))}
              placeholder="Delay between runs, e.g. 30" />
          </div>
        )}

        <label className="label">Coupon code <span className="faint">(optional)</span></label>
        <div className="flex">
          <input className="input" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())}
            placeholder="e.g. WELCOME10" style={{ textTransform: 'uppercase' }} />
          <button type="button" className="btn btn-outline" onClick={runQuote} disabled={quoteBusy}>
            {quoteBusy ? 'Applying…' : 'Apply'}
          </button>
        </div>

        {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}
        {q?.invalidCoupon && <div className="field-error"><Icon name="alert" size={15} /> Coupon not found or expired.</div>}
        {q?.belowMin && <div className="field-error"><Icon name="alert" size={15} /> This coupon needs a minimum order value.</div>}

        <div className="divider" />
        <div className="stack" style={{ gap: 8 }}>
          <div className="flex between"><span className="muted">Price</span><span>{q ? fmtInr(preCoupon) : (svc && qty ? fmtInr(Math.round(Number(qty) * svc.price_per_1k * 100 / 1000)) : '—')}</span></div>
          {discount > 0 && (
            <div className="flex between"><span className="muted" style={{ color: 'var(--success)' }}>Coupon discount</span>
              <span style={{ color: 'var(--success)' }}>−{fmtInr(discount)}</span></div>
          )}
          <div className="flex between"><b>Total</b>
            <b className="card-value" style={{ fontSize: '1.4rem', color: discount > 0 ? 'var(--success)' : 'inherit' }}>
              {q ? fmtInr(finalPrice) : '—'}
            </b></div>
        </div>

        <div className="flex" style={{ marginTop: 20, justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="muted" style={{ fontSize: '0.9rem' }}>
            Wallet balance: <b style={{ color: 'var(--text)' }}>{fmtInr(user.wallet_inr)}</b>
            {quote && finalPrice > user.wallet_inr && (
              <div style={{ marginTop: 4 }}>
                <Link to="/deposit" className="insufficient-link">
                  <Icon name="deposit" size={14} style={{ verticalAlign: '-2px' }} />
                  Deposit {fmtInr(finalPrice - user.wallet_inr)} more to continue
                </Link>
              </div>
            )}
          </div>
          <button className="btn btn-primary" disabled={placing || !svc || !link.trim() || !qty || !quote}>
            {placing ? 'Placing order…' : <><Icon name="zap" size={15} /> Pay & Place Order</>}
          </button>
        </div>
      </form>
    </>
  );
}