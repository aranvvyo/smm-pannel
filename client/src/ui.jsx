// UI helpers & shared micro-components.
import { useState, useEffect, useCallback, createContext, useContext } from 'react';

export const fmtInr = (paise, digits = 2) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtUsd = (floatStrOrNum) => {
  const n = Number(floatStrOrNum);
  return Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$0.00';
};

// Format a subunit-less rate (e.g. exchange rate 100 → "₹100.00").
export const fmtRateINR = (rate, digits = 2) =>
  '₹' + (Number(rate) || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const timeAgo = (ms) => {
  const s = Math.floor((Date.now() - Number(ms)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const dateStr = (ms) => new Date(Number(ms)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export const ORDER_STATUSES = {
  PENDING: { label: 'Pending', cls: 'badge-warn', dot: '#fbbf24' },
  IN_PROGRESS: { label: 'In Progress', cls: 'badge-b', dot: '#34d399' },
  COMPLETED: { label: 'Completed', cls: 'badge-success', dot: '#34d399' },
  PARTIAL: { label: 'Partial', cls: 'badge-info', dot: '#38bdf8' },
  CANCELED: { label: 'Canceled', cls: 'badge-danger', dot: '#f87171' },
  CANCELLED: { label: 'Canceled', cls: 'badge-danger', dot: '#f87171' },
  FAILED: { label: 'Failed', cls: 'badge-danger', dot: '#f87171' },
  REFUNDED: { label: 'Refunded', cls: 'badge-muted', dot: '#94a3b8' },
};

export function StatusBadge({ status }) {
  const s = ORDER_STATUSES[status] || { label: status || '—', cls: 'badge-muted', dot: '#64748b' };
  return <span className={`badge ${s.cls}`}><span className="dot" style={{ background: s.dot }} />{s.label}</span>;
}

/** Shared SVG icon set — stroke-based, inherits currentColor. Never use emojis in the UI. */
const PATHS = {
  logo: ['M3 12l3.4-2.4 3.1-4.9 1.6 4 .5.6 3.2-.2-2.7 2.3.5 1.6-4.2-1.2-1.3 1.4 1.4 2.5-1.5.3-1-2.6L3 12zm11.4-7.6l1.8.6-1.9 2.5-1.2-.4 1.3-2.7zm2.1 2l1.9-1.8.5 1.9-1.6.6-.8-.7zm-4.9 5.4l6.4-5.7.8 1.8-5.3 5.2-1.9-.4v-.9z'],
  rocket: ['M4.5 16.2c1.5.6 2.6.7 4 .5M4.5 16.2C2.9 18 .4 19.3.4 19.3c1.8.4 4 .5 5.4 0M4.5 16.2l-.5 3.1m9.6-12.6a5 5 0 1 1 4.7 4.7l-12.5 2.6a1 1 0 0 1-1.1-.5l-1-1.9a1 1 0 0 1 .1-1.2l2.7-3a1 1 0 0 1 .9-.3l6.2 1.6zM16.5 7.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z'],
  dashboard: ['M3 4h7v6H3V4zm0 10h7v6H3v-6zM14 4h7v12h-7V4zm0 16h7v2h-7v-2z'],
  order: ['M6 3.5h11l1.5 2v15H5.5v-15L7 3.5z', 'M9 3.5V6h6V3.5', 'M9.5 11h5', 'M9.5 14.5h5'],
  wallet: ['M2.5 6.5A2 2 0 0 1 4.5 4.5h13v15h-13a2 2 0 0 1-2-2v-11z', 'M21.5 9v6h-6a2 2 0 0 1 0-4h6z', 'M16 12h.01'],
  deposit: ['M12 3v12', 'm6 11 6 6 6-6', 'M4 21h16'],
  support: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  bell: ['M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9z', 'M10 19a2.2 2.2 0 0 0 3.2 0'],
  user: ['M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20a8 8 0 0 1 16 0'],
  logout: ['M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3', 'M10 12h10', 'm15 8 4 4-4 4'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  search: ['M20 20l-4.4-4.4', 'M10.5 17.5a7 7 0 1 1 0-14 7 7 0 0 1 0 14z'],
  copy: ['M8 8h12v12H8V8z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  check: ['M4.5 12.5l5 5 10-11'],
  checkCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'm8.5 12 2.5 2.5 4.5-5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 8v5', 'M12 16.5v.01', 'M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8v.01'],
  refresh: ['M20 11a8.1 8.1 0 0 0-14.7-4.8L3 9', 'M3 4v5h5', 'M4 13a8.1 8.1 0 0 0 14.7 4.8L21 15', 'M21 20v-5h-5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  calendar: ['M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M8 2v5', 'M16 2v5', 'M3 9h18'],
  arrowRight: ['M4 12h16', 'm13 5 7 7-7 7'],
  arrowLeft: ['M20 12H4', 'm11 19-7-7 7-7'],
  arrowUp: ['M12 20V4', 'm5 11 7-7 7 7'],
  arrowDown: ['M12 4v16', 'm19 13-7 7-7-7'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronUp: ['m6 15 6-6 6 6'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  star: ['M12 3l2.6 5.7 6.2.7-4.6 4.2 1.2 6.1L12 16.9 6.6 19.7l1.2-6.1L3.2 9.4l6.2-.7L12 3z'],
  heart: ['M12 20.7c-4.7-4-7.5-6.9-7.5-9.8A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7.5 2.9c0 2.9-2.8 5.8-7.5 9.8z'],
  shield: ['M12 3l8 3v5c0 5.5-3.4 8.9-8 10-4.6-1.1-8-4.5-8-10V6l8-3z', 'M8.5 11.5l2.5 2.5 4.5-4.5'],
  zap: ['M13 3 4 14h6l-1 7 9-11h-6l1-7z'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: ['M17.5 6.5A10 10 0 0 0 12 5C5 5 2 12 2 12a17 17 0 0 0 5 4.5M9.8 9.8a3 3 0 0 0 4.4 4.4M8 19.4A10 10 0 0 0 12 19c7 0 10-7 10-7a17.6 17.6 0 0 0-2.5-3.5', 'M2 2l20 20'],
  money: ['M3 8h18a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M7 12h10', 'M12 9.5v5'],
  creditCard: ['M3 6h18v12H3V6z', 'M3 10h18'],
  bank: ['M4 10l8-6 8 6', 'M6 10v8', 'M10 10v8', 'M14 10v8', 'M18 10v8', 'M3 21h18'],
  coins: ['M12 8c-4.4 0-8-1.6-8-3.5S7.6 1 12 1s8 1.6 8 3.5S16.4 8 12 8z', 'M4 8v3.5C4 13.4 7.6 15 12 15s8-1.6 8-3.5V8', 'M4 11.5V15c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-3.5'],
  ticket: ['M3 9a2 2 0 0 0 0 4v7a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7a2 2 0 1 0 0-4V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v4z', 'M14 6v12', 'M5 3.5h18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z', 'M7 10h4', 'M7 14h4'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  inbox: ['M21 12h-4l-2 3H9l-2-3H3l2 10h14l2-10z'],
  package: ['M12 2l9 4.5v11L12 22l-9-4.5v-11L12 2z', 'M3 6.5l9 4.5 9-4.5', 'M12 11v11'],
  trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
  edit: ['M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8L4 5z'],
  download: ['M12 4v12', 'm6 11 6 6 6-6', 'M5 21h14'],
  upload: ['M12 16V4', 'm6 9 6-6 6 6', 'M5 21h14'],
  phone: ['M6 3h4l1.5 5L9 9.5a12 12 0 0 0 5.5 5.5L17 13l5 1.5v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z'],
  mail: ['M3 6h18v12H3V6z', 'm3 7 9 6 9-6'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c2.5 2.7 3.7 5.8 3.7 9S14.5 18.3 12 21c-2.5-2.7-3.7-5.8-3.7-9S9.5 5.7 12 3z'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M3.5 20a5.5 5.5 0 0 1 11 0', 'M16 5a3.5 3.5 0 0 1 1 6.9', 'M17.5 14.2A6 6 0 0 1 20.5 20'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2 1.2L10 21h4l.5-2.5a7 7 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.06-.4.1-.8.1-1.2z'],
  log: ['M4 4h7v16H4V4z', 'M15 9h5', 'M15 13h5', 'M15 17h3'],
  chart: ['M4 20V10', 'M9.5 20V4', 'M15 20v-7', 'M20.5 20H2m18.5 0V8'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v4a6 6 0 0 1-12 0V8z', 'M12 18v3'],
  link: ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5'],
  qr: ['M4 4h7v7H4V4z', 'M13 4h7v7h-7V4z', 'M4 13h7v7H4v-7z', 'M18 13h3v3h-3z', 'M13 15h3v3h-3z', 'M17 18h3v3h-3v-1.5', 'M20 14v-1'],
  flame: ['M12 22c4.4 0 7-2.5 7-6 0-2.5-1.5-4.5-2.5-6.5C15 7 16 3 12 3c0 2-.5 5-3 6.5S4 12 4 16c0 3.5 2.6 6 8 6z'],
  gift: ['M4 12h16v9H4v-9z', 'M3 8h18v4H3V8z', 'M12 8v13', 'M12 8s-2-5-5-5c-1.5 0-3 1.5-3 3.5S9 8 12 8zm0 0s2-5 5-5c1.5 0 3 1.5 3 3.5S15 8 12 8z'],
  hash: ['M5 9h14', 'M5 15h14', 'M10 3 8 21', 'M16 3l-2 18'],
  play: ['M7 4l13 8-13 8V4z'],
  music: ['M9 18V5l11-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  pause: ['M8 5v14', 'M16 5v14'],
  ban: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M5.6 5.6l12.8 12.8'],
  pencil: ['M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4z'],
  trendingUp: ['m3 16 6-6 4 4 8-8', 'M21 6h-6', 'M21 6v6'],
  trendUp: ['m3 17 6-6 4 4 8-8', 'M21 7v6', 'M21 7h-6'],
  sparkles: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z', 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z'],
  lock: ['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M12 14.5v2.5'],
  unlock: ['M7 10V7a5 5 0 0 1 9.8-1.5', 'M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z'],
  bolt: ['M13 3 4 14h6l-1 7 9-11h-6l1-7z'],
  clockFast: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  layers: ['M12 3 2.5 8 12 13l9.5-5L12 3z', 'M2.5 12L12 17l9.5-5', 'M2.5 16L12 21l9.5-5'],
  gauge: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 13l4-4', 'M12 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  moon: ['M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9z'],
  sun: ['M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9M19.1 19.1l-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z'],
  grid: ['M4 4h6v6H4V4z', 'M14 4h6v6h-6V4z', 'M4 14h6v6H4v-6z', 'M14 14h6v6h-6v-6z'],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 5.5h.01', 'M4 11.5h.01', 'M4 17.5h.01'],
  headphone: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3l-1.5 5H5a2 2 0 0 1-2-2v-3zm16 0h-3l1.5 5H19a2 2 0 0 0 2-2v-3z'],
  percent: ['M5 19 19 5', 'M7 8h.01', 'M16.5 16.5h.01'],
  x: ['M6 6l12 12M18 6L6 18'],
  camera: ['M4 8h2l2-3h8l2 3h2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  thumbsUp: ['M7 21h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-3l1-4.5C16 2 14.5 1.5 13.8 2.2c-.4.4-.8 1.8-.8 2.8L11.7 9H4a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1.5L4 20a2 2 0 0 0 2 1.5'],
  birds: ['M4 17c1 2 5 3 8 1.5', 'M12 18c3.5-1.5 5-5 6-8 1.5 1 2.5 3 2 4.5-.5 2-2.5 3.5-5 3.5', 'M7 16C6 14 4.5 11 4.5 8.5c0-1 1-2 2-1.5.3.2 1-.4.5-1.8C7 4.5 8.3 4.5 9 5c.6.4 1.9 1.5 2 3.5', 'M3 5l3.5 1L8 9'],
  };

export function Icon({ name, size = 20, stroke = 1.8, className = '', style, filled = false, box = 24 }) {
  const d = PATHS[name] || PATHS.alert;
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${box} ${box}`}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} aria-hidden="true"
    >
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="loading-screen">
      <svg className="spin" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" />
      </svg>
      <span style={{ marginLeft: 10 }}>{label}</span>
    </div>
  );
}

export function Empty({ icon = 'inbox', text = 'Nothing here yet.', sub = null }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={34} stroke={1.4} /></div>
      <div className="empty-text">{text}</div>
      {sub && <div className="empty-sub">{sub}</div>}
    </div>
  );
}

/* ---- Toasts ---- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const toast = useCallback((msg, kind = 'info') => {
    const id = Date.now() + Math.random().toString(36).slice(2);
    setItems((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ onClose, children, title }) {
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title || 'Dialog'} onClick={(e) => e.stopPropagation()}>
        {title && <h3 style={{ marginBottom: 14 }}>{title}</h3>}
        {children}
      </div>
    </div>
  );
}

/** Poll `fn` every `ms` while mount is active (with immediate first run). */
export function usePoll(fn, ms = 15000, deps = []) {
  const cb = useCallback(fn, deps);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { if (alive) await cb(); } catch { /* ignore poll errors */ } };
    tick();
    const id = setInterval(tick, ms);
    return () => { alive = false; clearInterval(id); };
  }, [cb, ms]);
}

export function useCountUp(target, duration = 900) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

/* ---- Tiny SVG line/bar charts ---- */
export function LineChart({ data, labelKey = 'day', valueKey = 'profitInr', height = 180, color = '#10b981' }) {
  const W = 600, H = height, P = 28;
  const vals = data.map((d) => Number(d[valueKey]) || 0);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const x = (i) => P + (i * (W - P * 2)) / Math.max(1, data.length - 1);
  const y = (v) => H - P - ((v - min) / range) * (H - P * 2);
  const pts = data.map((d, i) => `${x(i)},${y(Number(d[valueKey]) || 0)}`).join(' ');
  const area = data.length > 1 ? `${pts} ${x(data.length - 1)},${H - P} ${x(0)},${H - P}` : '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
      <defs>
        <linearGradient id="areafill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={P} x2={W - P} y1={H - P * 2 * f - P} y2={H - P * 2 * f - P} stroke="#263449" strokeDasharray="3 4" />
      ))}
      {data.length > 1 && <polygon points={area} fill="url(#areafill)" />}
      {data.length > 1 && <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {data.map((d, i) => <circle key={i} cx={x(i)} cy={y(Number(d[valueKey]) || 0)} r="3" fill={color}><title>{d[labelKey]}</title></circle>)}
      {data.map((d, i) => (i % Math.ceil(data.length / 6) === 0) && (
        <text key={i} x={x(i)} y={H - 10} textAnchor="middle">{String(d[labelKey]).slice(5)}</text>
      ))}
    </svg>
  );
}

export function BarChart({ data, valueKey = 'depositsInr', height = 180, color = '#34d399' }) {
  const W = 600, H = height, P = 28;
  const vals = data.map((d) => Number(d[valueKey]) || 0);
  const max = Math.max(...vals, 1);
  const bw = (W - P * 2) / Math.max(1, data.length) * 0.62;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={P} x2={W - P} y1={H - P * 2 * f - P} y2={H - P * 2 * f - P} stroke="#263449" strokeDasharray="3 4" />
      ))}
      {data.map((d, i) => {
        const bh = ((Number(d[valueKey]) || 0) / max) * (H - P * 2);
        const cx = P + (i * (W - P * 2)) / data.length + ((W - P * 2) / data.length - bw) / 2;
        return <rect key={i} x={cx} y={H - P - bh} width={bw} height={Math.max(bh, 1)} rx="4" fill={color} opacity="0.85"><title>{`${d.day}: ${d[valueKey]}`}</title></rect>;
      })}
      {data.map((d, i) => (i % Math.ceil(data.length / 6) === 0) && (
        <text key={i} x={P + (i * (W - P * 2)) / data.length} y={H - 10} textAnchor="middle">{String(d.day).slice(5)}</text>
      ))}
    </svg>
  );
}