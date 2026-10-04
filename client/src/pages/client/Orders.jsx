import { useMemo, useState } from 'react';
import { get } from '../../api.js';
import { usePoll, fmtInr, timeAgo, StatusBadge, Empty } from '../../ui.jsx';

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

  usePoll(async () => {
    const d = await get('/api/orders');
    setOrders(d.orders);
    setLoaded(true);
  }, 10000);

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
                <tr><th>Order</th><th>Service</th><th>Qty</th><th>Progress</th><th>Status</th><th>Price</th><th>When</th></tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id} id={`o${o.id}`}>
                    <td className="mono" style={{ color: 'var(--info)' }}>{o.order_ref}</td>
                    <td>{o.service_name}<div className="faint" style={{ fontSize: '0.8rem' }}>{o.category_name}</div></td>
                    <td>{Number(o.quantity).toLocaleString()}</td>
                    <td>
                      {['IN_PROGRESS', 'PARTIAL', 'COMPLETED'].includes(o.status)
                        ? <ProgressCell o={o} />
                        : <span className="faint">—</span>}
                    </td>
                    <td><StatusBadge status={o.status} /></td>
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
