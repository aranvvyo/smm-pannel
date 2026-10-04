import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { get } from '../../api.js';
import { useState } from 'react';
import { fmtInr, fmtUsd, usePoll, timeAgo, StatusBadge, Empty, Icon } from '../../ui.jsx';

// A hierarchy of wallets/cards: lifetime spend feeds the "total spent" card,
// today's real ledger aggregate feeds the "Today's spend" card.
export default function ClientDashboard() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);

  usePoll(async () => {
    const [w, o] = await Promise.all([get('/api/wallet'), get('/api/orders')]);
    setWallet(w);
    setOrders(o.orders.slice(0, 5));
  }, 15000);

  const recent = orders;

  return (
    <div className="anime-page">
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Welcome back{user?.name ? `, ${user.name}` : ''}</p>

      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        <div className="card card-gradient">
          <div className="card-label">Available balance (INR)</div>
          <div className="card-value">{wallet ? fmtInr(wallet.balance_inr) : '…'}</div>
          <div className="flex" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <Link to="/deposit" className="btn btn-primary btn-sm"><Icon name="deposit" size={15} stroke={2.2} /> Deposit</Link>
            <Link to="/order" className="btn btn-outline btn-sm"><Icon name="plus" size={15} stroke={2.2} /> New Order</Link>
          </div>
        </div>

        {/* Today's spend — real ledger aggregate for today (IST bucket). */}
        <div className="card">
          <div className="card-label">Today&apos;s spend</div>
          <div className="card-value" style={{ fontSize: '1.35rem' }}>
            {wallet ? fmtInr(wallet.today_spent_inr) : '…'}
          </div>
          <div className="muted" style={{ fontSize: '0.9rem' }}>
            Lifetime: {wallet ? `${fmtInr(wallet.total_spent_inr)}` : '…'}
            {wallet ? ` = $${wallet.total_spent_usd}` : ''}
          </div>
        </div>
      </div>

      {/* Engagement cards: real DB counts / actions, never a sliced-array number. */}
      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-label"><Icon name="order" size={14} stroke={2} /> Orders</div>
          <div className="card-value" style={{ fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            {wallet ? wallet.stats?.orders_total ?? 0 : '…'}
            <Link to="/orders" className="faint" style={{ fontSize: '0.8rem' }}>view all →</Link>
          </div>
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {wallet ? (wallet.stats?.orders_completed ?? 0) + ' completed' : ''}
          </div>
        </div>
        <div className="card">
          <div className="card-label"><Icon name="wallet" size={14} stroke={2} /> Balance (INR)</div>
          <div className="card-value" style={{ fontSize: '1.15rem' }}>{wallet ? fmtInr(wallet.balance_inr) : '…'}</div>
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {wallet ? (wallet.stats?.deposits_total ?? 0) + ' deposits' + (wallet.stats?.deposits_pending ? ` · ${wallet.stats.deposits_pending} awaiting payment` : '') : ''}
          </div>
        </div>
        <div className="card">
          <div className="card-label"><Icon name="sparkles" size={14} stroke={2} /> What&apos;s next</div>
          <div className="muted" style={{ fontSize: '0.85rem', paddingTop: 6 }}>
            {orders.length === 0 ? 'Place your first order to get started.' : 'Track progress on your recent orders.'}
          </div>
        </div>
      </div>

      <h2 className="page-sub" style={{ fontWeight: 800, color: 'var(--text)' }}>Recent orders</h2>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {recent.length === 0 ? (
          <Empty icon="package" text="No orders yet — place your first order!" />
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead><tr><th>Order</th><th>Service</th><th>Status</th><th>Price</th><th>When</th></tr></thead>
              <tbody>
                {recent.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/orders#o${o.id}`} className="mono faint" style={{ color: 'var(--info)' }}>{o.order_ref}</Link></td>
                    <td>{o.service_name}<div className="faint" style={{ fontSize: '0.8rem' }}>{o.category_name}</div></td>
                    <td><StatusBadge status={o.status} /></td>
                    <td>{fmtInr(o.price_inr)}</td>
                    <td className="faint">{timeAgo(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <Link to="/orders" className="btn btn-outline btn-sm">View all orders <Icon name="arrowRight" size={14} stroke={2.2} /></Link>
      </div>
    </div>
  );
}