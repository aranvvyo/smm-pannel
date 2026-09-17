import { useState } from 'react';
import { get } from '../../api.js';
import { usePoll, fmtInr, timeAgo, StatusBadge, Empty } from '../../ui.jsx';

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loaded, setLoaded] = useState(false);

  usePoll(async () => {
    const d = await get('/api/orders');
    setOrders(d.orders);
    setLoaded(true);
  }, 10000);

  return (
    <>
      <h1 className="page-title">My Orders</h1>
      <p className="page-sub">Live status of every order — updates automatically.</p>

      {loaded && orders.length === 0 ? (
        <div className="card"><Empty icon="package" text="You haven't placed any orders yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Order</th><th>Service</th><th>Qty</th><th>Progress</th><th>Status</th><th>Price</th><th>When</th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} id={`o${o.id}`}>
                    <td className="mono" style={{ color: 'var(--info)' }}>{o.order_ref}</td>
                    <td>{o.service_name}<div className="faint" style={{ fontSize: '0.8rem' }}>{o.category_name}</div></td>
                    <td>{o.quantity.toLocaleString()}</td>
                    <td>
                      {['IN_PROGRESS', 'PARTIAL', 'COMPLETED'].includes(o.status)
                        ? <span className="faint">{Number(o.start_count || 0).toLocaleString()} / {Number(o.remains || 0).toLocaleString()}</span>
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