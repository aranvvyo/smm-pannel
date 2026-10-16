import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr, StatusBadge, Empty } from '../../ui.jsx';

const STATUSES = ['ALL', 'AMBIGUOUS', 'SUBMITTING', 'REJECTED', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'CANCELED', 'CANCELLED', 'FAILED', 'REFUNDED'];

export default function AdminOrders() {
  const toast = useToast();
  const [status, setStatus] = useState('ALL');
  const [q, setQ] = useState('');
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const load = async (st = status, query = q) => {
    const d = await get(`/api/admin/orders?status=${st}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
    setOrders(d.orders); setLoaded(true);
  };
  useEffect(() => { load('ALL', ''); }, []);

  const change = (fn) => (v) => { fn(v); load(v, q); };
  const onSearch = (e) => { e.preventDefault(); load(status, q); };

  const act = async (o, kind) => {
    if (kind === 'cancel' && !window.confirm(`Cancel #${o.order_ref}? The provider is called; the unused portion may be refunded.`)) return;
    try {
      const d = await post(`/api/admin/orders/${o.id}/${kind}`, {});
      const refundNote = kind === 'cancel' && d.refund_inr > 0
        ? ` — ${fmtInr(d.refund_inr)} refunded.` : '';
      if (kind === 'refill') toast('Refill requested. The supplier accepted it.', 'success');
      else toast(`Order ${d.status}.${refundNote}`, 'success');
      load(status, q);
    } catch (x) { toast(x.message, 'error'); }
  };

  return (
    <>
      <h1 className="page-title">Orders</h1>
      <p className="page-sub">Every order across all clients.</p>

      <div className="filter-chips">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => change(setStatus)(s)}>{s}</button>
        ))}
      </div>

      <form onSubmit={onSearch} className="flex mb" style={{ marginBottom: 18 }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or order ref…" style={{ maxWidth: 340 }} />
        <button className="btn btn-outline">Search</button>
      </form>

      {loaded && orders.length === 0 ? (
        <div className="card"><Empty icon="package" text="No orders match." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Order</th><th>Client</th><th>Service</th><th>Qty</th><th>Amount</th><th>Base</th><th>Status</th><th>Progress</th><th>Created (IST)</th><th></th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono" style={{ color: 'var(--info)' }}>{o.order_ref}</td>
                    <td>{o.email}</td>
                    <td>{o.service_name}</td>
                    <td>{o.quantity.toLocaleString()}</td>
                    <td>{fmtInr(o.price_inr)}</td>
                    <td className="faint">{fmtInr(o.base_cost_inr)}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td className="faint">{Number(o.start_count || 0).toLocaleString()}/{Number(o.remains || 0).toLocaleString()}</td>
                    <td className="faint">{o.created_at_ist}</td>
                    <td>
                      <div className="flex">
                        {['PENDING', 'IN_PROGRESS'].includes(o.status) && Number(o.cancel) === 1 && (
                          <button className="btn btn-ghost btn-sm" onClick={() => act(o, 'cancel')}>Cancel</button>
                        )}
                        {['PENDING', 'IN_PROGRESS'].includes(o.status) && Number(o.refill) === 1 && (
                          <button className="btn btn-ghost btn-sm" onClick={() => act(o, 'refill')}>Refill</button>
                        )}
                      </div>
                    </td>
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