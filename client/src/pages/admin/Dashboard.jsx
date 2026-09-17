import { useState } from 'react';
import { get } from '../../api.js';
import { usePoll, fmtInr, fmtUsd, timeAgo, StatusBadge, LineChart, BarChart } from '../../ui.jsx';

export default function AdminDashboard() {
  const [d, setD] = useState(null);

  usePoll(async () => { setD(await get('/api/admin/dashboard')); }, 20000);

  if (!d) return <div className="faint">Loading dashboard…</div>;

  const m = d.metrics;
  const series = d.series || [];

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Sales, profit and deposits — IST buckets, live numbers.</p>

      <div className="grid grid-4">
        <div className="card stat-tile card-gradient">
          <div className="card-label">Total profit</div>
          <div className="stat-n">{fmtInr(m.totalProfitInr)}</div>
          <div className="stat-d">margin {m.profitPct}%</div>
        </div>
        <div className="card stat-tile">
          <div className="card-label">Revenue / cost</div>
          <div className="stat-n" style={{ fontSize: '1.15rem' }}>{fmtInr(m.totalRevenueInr)}</div>
          <div className="stat-d">provider cost {fmtInr(m.totalCostInr)}</div>
        </div>
        <div className="card stat-tile">
          <div className="card-label">Crypto deposits</div>
          <div className="stat-n">{fmtInr(m.total)}</div>
          <div className="stat-d">{m.count} confirmed · {m.today_count} today · {fmtInr(m.today)} today</div>
        </div>
        <div className="card stat-tile">
          <div className="card-label">Orders this month</div>
          <div className="stat-n">{m.monthly.orders}</div>
          <div className="stat-d">profit {fmtInr(m.monthly.profitInr)}</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 20 }}>
        <div className="card">
          <div className="card-label"><b style={{ color: 'var(--text)' }}>Daily profit</b> (last 14d)</div>
          <LineChart data={series} valueKey="profitInr" height={200} />
        </div>
        <div className="card">
          <div className="card-label"><b style={{ color: 'var(--text)' }}>Daily deposits</b> (last 14d)</div>
          <BarChart data={series} valueKey="depositsInr" height={200} />
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 20 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="flex between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)' }}>
            <b>Recent orders</b>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead><tr><th>Order</th><th>Service</th><th>Status</th><th>Total</th><th>When</th></tr></thead>
              <tbody>
                {d.recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono" style={{ color: 'var(--info)' }}>{o.order_ref}</td>
                    <td>{o.service_name}<div className="faint" style={{ fontSize: '0.78rem' }}>{o.email}</div></td>
                    <td><StatusBadge status={o.status} /></td>
                    <td>{fmtInr(o.price_inr)}</td>
                    <td className="faint">{timeAgo(o.created_at)}</td>
                  </tr>
                ))}
                {d.recentOrders.length === 0 && <tr><td colSpan={5} className="faint">No orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="flex between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)' }}>
            <b>Recent deposits</b>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead><tr><th>User</th><th>Amount</th><th>Coin</th><th>Status</th></tr></thead>
              <tbody>
                {d.recentDeposits.map((dp) => (
                  <tr key={dp.id}>
                    <td>{dp.email}</td>
                    <td>{fmtUsd((dp.amount_usd || 0) / 100)} <span className="faint">≈ {fmtInr(dp.amount_inr)}</span></td>
                    <td>{dp.currency}</td>
                    <td>
                      <span className={`badge ${dp.status === 'confirmed' ? 'badge-success' : dp.status === 'pending' ? 'badge-warn' : 'badge-muted'}`}>
                        <span className="dot" style={{ background: dp.status === 'confirmed' ? 'var(--success)' : 'var(--warn)' }} />
                        {dp.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {d.recentDeposits.length === 0 && <tr><td colSpan={4} className="faint">No deposits yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}