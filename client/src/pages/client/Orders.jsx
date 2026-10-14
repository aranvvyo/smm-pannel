import { useMemo, useState } from 'react';
import { get, post } from '../../api.js';
import { usePoll, fmtInr, timeAgo, StatusBadge, Empty } from '../../ui.jsx';
import { cleanDisplayText } from '../../lib/serviceFormat.js';

// Customer refill state, from server-provided flags only. The button is shown only
// when the service supports refill AND the order is eligible; otherwise a reason is shown.
const REFILL_LABELS = {
  REQUESTED: 'Refill sending',
  ACCEPTED: 'Refill requested',
  AMBIGUOUS: 'Refill under review',
};
function RefillCell({ o, busy, onRefill }) {
  if (!Number(o.refill_supported)) return <span className="faint">—</span>;
  if (REFILL_LABELS[o.refill_status]) {
    return <span className="badge badge-info">{REFILL_LABELS[o.refill_status]}</span>;
  }
  const eligible = ['COMPLETED', 'PARTIAL'].includes(o.status);
  if (!eligible) return <span className="faint" style={{ fontSize: '0.8rem' }}>Available after delivery starts</span>;
  return (
    <button type="button" className="btn btn-outline btn-sm" disabled={busy}
      onClick={() => onRefill(o)}>
      {busy ? 'Requesting…' : 'Refill'}
    </button>
  );
}

const FILTERS = ['ALL', 'PENDING', 'IN_PROGRESS', 'PARTIAL', 'COMPLETED', 'CANCELED', 'CANCELLED', 'FAILED', 'REFUNDED'];

// Delivered = ordered − remaining. A thin bar makes live progress
// obvious without waiting for a status flip.
function ProgressCell({ o }) {
  const qty = Number(o.quantity) || 0;
  const remains = Number(o.remains) || 0;
  const done = Math.max(0, qty - remains);
  const pct = qty > 0 ? Math.min(100, Math.round((done / qty) * 100)) : 0;
  const color = o.status === 'COMPLETED'
    ? 'var(--success)'
    : o.status === 'PARTIAL' ? 'var(--info)' : 'var(--accent-2)';
  return (
    <div style={{ minWidth: 130 }}>
      <div className="flex between" style={{ fontSize: '0.78rem', marginBottom: 4 }}>
        <span className="faint">{done.toLocaleString()} / {qty.toLocaleString()}</span>
        <span className="faint">{pct}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 99, background: 'rgba(148,163,184,0.15)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: color, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('ALL');

  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    const d = await get('/api/orders');
    setOrders(d.orders);
    setLoaded(true);
  };
  usePoll(refresh, 10000);

  const requestRefill = async (o) => {
    setNotice('');
    setBusyId(o.id);
    try {
      await post(`/api/orders/${o.id}/refill`, {});
      setNotice(`Refill requested for ${o.order_ref}.`);
    } catch (e) {
      setNotice(e.message || 'The refill could not be requested. Please try again later.');
    } finally {
      setBusyId(null);
      refresh().catch(() => {});
    }
  };

  const counts = useMemo(() => {
    const c = { ALL: orders.length };
    for (const o of orders) c[o.status] = (c[o.status] || 0) + 1;
    return c;
  }, [orders]);

  const visible = useMemo(
    () => (filter === 'ALL' ? orders : orders.filter((o) => o.status === filter)),
    [orders, filter]
  );

  return (
    <>
      <h1 className="page-title">My Orders</h1>
      <p className="page-sub">Live status of every order — updates automatically.</p>
      {notice && <p role="status" className="muted" style={{ margin: '8px 0' }}>{notice}</p>}

      <div className="filter-chips">
        {FILTERS.filter((f) => f === 'ALL' || counts[f]).map((s) => (
          <button key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
            {s} ({counts[s] ?? 0})
          </button>
        ))}
      </div>

      {loaded && visible.length === 0 ? (
        <div className="card"><Empty icon="package" text={filter === 'ALL' ? 'You haven\'t placed any orders yet.' : 'No orders with this status.'} /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Order</th><th>Service</th><th>Qty</th><th>Progress</th><th>Status</th><th>Refill</th><th>Price</th><th>When</th></tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id} id={`o${o.id}`}>
                    <td className="mono" style={{ color: 'var(--info)' }}>{o.order_ref}</td>
                    <td>{cleanDisplayText(o.service_name)}<div className="faint" style={{ fontSize: '0.8rem' }}>{cleanDisplayText(o.category_name)}</div></td>
                    <td>{Number(o.quantity).toLocaleString()}</td>
                    <td>
                      {['IN_PROGRESS', 'PARTIAL', 'COMPLETED'].includes(o.status)
                        ? <ProgressCell o={o} />
                        : <span className="faint">—</span>}
                    </td>
                    <td><StatusBadge status={o.status} /></td>
                    <td><RefillCell o={o} busy={busyId === o.id} onRefill={requestRefill} /></td>
                    <td>
                      {fmtInr(o.price_inr)}
                      {o.discount_inr > 0 && <div className="faint" style={{ fontSize: '0.78rem' }}>−{fmtInr(o.discount_inr)} coupon</div>}
                    </td>
                    <td className="faint">{timeAgo(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
