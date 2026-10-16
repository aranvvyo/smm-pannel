import { useMemo, useState } from 'react';
import { get, post } from '../../api.js';
import { usePoll, fmtInr, timeAgo, StatusBadge, Empty, useToast } from '../../ui.jsx';

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

// Refill control for one order. Eligibility comes from the server (o.refill); this
// component only displays it. While a request is running every refill action is
// disabled, so a double click cannot send a second supplier request.
const REFILL_DONE_STATUSES = ['COMPLETED', 'PARTIAL'];

function RefillControl({ o, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null); // null | 'submit' | 'status'
  const [note, setNote] = useState(null); // { tone: 'ok' | 'err', text }
  const refill = o.refill;
  if (!refill || !refill.supported) return null; // service does not offer refill: show nothing

  const submit = async () => {
    setBusy('submit');
    setNote(null);
    try {
      await post(`/api/orders/${o.id}/refill`, {});
      setNote({ tone: 'ok', text: 'Refill requested. The supplier accepted the request.' });
      toast('Refill requested.', 'success');
    } catch (e) {
      const text = e.message || 'The refill could not be requested.';
      setNote({ tone: 'err', text });
      toast(text, 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const checkStatus = async () => {
    setBusy('status');
    setNote(null);
    try {
      const d = await post(`/api/orders/${o.id}/refill/status`, {});
      setNote({ tone: 'ok', text: `Supplier status: ${d.supplier_status}` });
    } catch (e) {
      setNote({ tone: 'err', text: e.message || 'The refill status could not be checked.' });
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const showReason = !refill.eligible && refill.reason
    && (REFILL_DONE_STATUSES.includes(o.status) || refill.status) && refill.status !== 'ACCEPTED';

  return (
    <div className="refill-cell">
      {refill.eligible && (
        <button className="btn btn-outline btn-sm refill-btn" onClick={submit} disabled={busy !== null}
          aria-busy={busy === 'submit'}>
          {busy === 'submit' ? 'Requesting…' : 'Refill'}
        </button>
      )}
      {refill.status === 'ACCEPTED' && (
        <>
          <span className="badge badge-info">Refill requested</span>
          <span className="faint refill-note">
            Supplier status: {refill.supplier_status || 'not checked yet'}
          </span>
          <button className="btn btn-ghost btn-sm refill-btn" onClick={checkStatus} disabled={busy !== null}
            aria-busy={busy === 'status'}>
            {busy === 'status' ? 'Checking…' : 'Check status'}
          </button>
        </>
      )}
      {showReason && <span className="faint refill-note">{refill.reason}</span>}
      {note && (
        <span role="status" className={`refill-note ${note.tone === 'err' ? 'refill-err' : 'refill-ok'}`}>
          {note.text}
        </span>
      )}
    </div>
  );
}

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('ALL');

  const load = async () => {
    const d = await get('/api/orders');
    setOrders(d.orders);
    setLoaded(true);
  };
  usePoll(load, 10000);

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
                    <td>
                      <StatusBadge status={o.status} />
                      <RefillControl o={o} onChanged={load} />
                    </td>
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
