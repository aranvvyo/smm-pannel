import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api.js';
import { usePoll, fmtInr, fmtUsd, timeAgo, Empty, Icon } from '../../ui.jsx';
import { INR_DEPOSIT_ENTRY_VISIBLE } from '../../lib/depositOptions.js';

const TX_META = {
  deposit: ['Deposit', 'deposit', 'var(--success)'],
  order: ['Order payment', 'creditCard', 'var(--info)'],
  refund: ['Refund', 'refresh', 'var(--success)'],
  admin_credit: ['Admin credit', 'plus', 'var(--success)'],
  admin_debit: ['Admin debit', 'minus', 'var(--warn)'],
};

export default function Wallet() {
  const [w, setW] = useState(null);
  const [tx, setTx] = useState([]);

  usePoll(async () => {
    const [w2, t] = await Promise.all([get('/api/wallet'), get('/api/wallet/transactions')]);
    setW(w2); setTx(t.transactions);
  }, 10000);

  return (
    <>
      <h1 className="page-title">Wallet</h1>
      <p className="page-sub">Your INR balance. Top up in crypto (USD, credited at the panel rate) or in INR via Deposit → Deposit INR (manual verification).</p>

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card card-gradient">
          <div className="card-label">Balance</div>
          <div className="card-value">{w ? fmtInr(w.balance_inr) : '…'}</div>
          {w != null && (
            <div className="muted" style={{ fontSize: '0.82rem', marginTop: 6 }}>Today&apos;s spend: {fmtInr(w.today_spent_inr)}</div>
          )}
          <div className="stack" style={{ gap: 8, marginTop: 14 }}>
            <Link to="/deposit" className="btn btn-primary btn-sm"><Icon name="deposit" size={15} stroke={2.2} /> Deposit</Link>
            {INR_DEPOSIT_ENTRY_VISIBLE && (
              <Link to="/deposit/inr" className="btn btn-outline btn-sm"><Icon name="bank" size={15} stroke={2.2} /> Deposit in INR</Link>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Total spent (USD)</div>
          <div className="card-value" style={{ fontSize: '1.3rem' }}>{w ? fmtUsd(w.total_spent_usd) : '…'}</div>
        </div>
        <div className="card">
          <div className="card-label">Total spent (INR)</div>
          <div className="card-value" style={{ fontSize: '1.3rem' }}>{w ? fmtInr(w.total_spent_inr) : '…'}</div>
          {w && <div className="faint" style={{ fontSize: '0.85rem', marginTop: 4 }}>rate: 1 USD = {w.exchange_rate} INR</div>}
        </div>
      </div>

      <h2 className="page-sub" style={{ fontWeight: 800, color: 'var(--text)' }}>Transaction history</h2>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {tx.length === 0 ? (
          <Empty icon="wallet" text="No transactions yet." />
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead><tr><th>Type</th><th>Amount</th><th>Balance after</th><th>Details</th><th>When</th></tr></thead>
              <tbody>
                {tx.map((t) => {
                  const [label, icon, color] = TX_META[t.type] || [t.type, 'info', 'var(--faint)'];
                  const meta = (() => { try { return JSON.parse(t.meta_json); } catch { return {}; } })();
                  return (
                    <tr key={t.id}>
                      <td>
                        <span style={{ color, verticalAlign: 'middle', display: 'inline-flex', marginRight: 6 }}>
                          <Icon name={icon} size={16} stroke={1.9} style={{ display: 'flex' }} />
                        </span>
                        {label}
                      </td>
                      <td style={{ color: t.amount_inr >= 0 ? 'var(--success)' : 'var(--text)', fontWeight: 700 }}>
                        {t.amount_inr >= 0 ? '+' : ''}{fmtInr(t.amount_inr)}
                      </td>
                      <td className="faint mono">{fmtInr(t.balance_after)}</td>
                      <td className="faint">{meta.service ? `Service: ${meta.service}` : (meta.email || (t.ref_id ? `#${t.ref_id}` : '—'))}</td>
                      <td className="faint">{timeAgo(t.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}