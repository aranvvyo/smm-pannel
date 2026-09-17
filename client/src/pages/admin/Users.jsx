import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr, timeAgo, Modal, Empty, Icon } from '../../ui.jsx';

export default function AdminUsers() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState(null); // {user, amount, mode}
  const [busy, setBusy] = useState(false);

  const load = async (query = q) => {
    const d = await get(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    setUsers(d.users); setLoaded(true);
  };
  useEffect(() => { load(''); }, []);

  const search = (e) => { e.preventDefault(); load(q); };

  const adjust = async (e) => {
    e.preventDefault();
    const amt = Number(edit.amount);
    if (!Number.isFinite(amt) || amt === 0) { toast('Enter a non-zero amount.', 'error'); return; }
    setBusy(true);
    try {
      const out = await post(`/api/admin/users/${edit.user.id}/balance`, { amount: amt });
      toast(`Balance ${amt > 0 ? 'credited' : 'debited'}.`, 'success');
      setEdit(null);
      load(q);
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const toggle = async (u, kind) => {
    const isBan = kind === 'ban';
    const confirmed = window.confirm(isBan
      ? `Ban ${u.email}? Their sessions are killed instantly. No warning is sent.`
      : `Re-activate ${u.email}?`);
    if (!confirmed) return;
    try {
      await post(`/api/admin/users/${u.id}/${isBan ? 'ban' : 'no-profit'}`, isBan ? { banned: u.status !== 'banned' } : { enabled: u.no_profit !== 1 });
      toast(isBan ? (u.status !== 'banned' ? `Banned ${u.email}` : `Unbanned ${u.email}`)
        : (u.no_profit !== 1 ? 'Added to favourite list' : 'Removed from favourite list'), 'success');
      load(q);
    } catch (x) { toast(x.message, 'error'); }
  };

  return (
    <>
      <h1 className="page-title">Users</h1>
      <p className="page-sub">{loaded ? `${users.length} client accounts` : ''}</p>

      <form onSubmit={search} className="flex mb" style={{ marginBottom: 18 }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by email or name…" style={{ maxWidth: 360 }} />
        <button className="btn btn-outline">Search</button>
      </form>

      {loaded && users.length === 0 ? (
        <div className="card"><Empty icon="users" text="No users found." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>User</th><th>Balance</th><th>Spend</th><th>Orders</th><th>Profit</th><th>Tags</th><th>Joined</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <b>{u.name || '—'}</b>
                      <div className="faint" style={{ fontSize: '0.8rem' }}>{u.email}</div>
                    </td>
                    <td>{fmtInr(u.wallet_balance)}</td>
                    <td>{fmtInr(u.total_spent_inr)}</td>
                    <td>{u.order_count}</td>
                    <td className="mono" style={{ color: 'var(--success)' }}>{fmtInr(u.profit_inr)}</td>
                    <td>
                      <div className="flex wrap">
                        {u.no_profit === 1 && <span className="badge badge-b"><Icon name="star" size={11} style={{ verticalAlign: '-1px' }} /> No-profit</span>}
                        {u.status === 'banned' && <span className="badge badge-danger">Banned</span>}
                        {u.status === 'active' && <span className="badge badge-success">Active</span>}
                      </div>
                    </td>
                    <td className="faint">{timeAgo(u.created_at)}</td>
                    <td>
                      <div className="flex">
                        <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ user: u, amount: '', mode: '' })}>Balance</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggle(u, 'ban')}>
                          {u.status === 'banned' ? 'Unban' : 'Ban'}
                        </button>
                        {u.no_profit !== 1
                          ? <button className="btn btn-ghost btn-sm" onClick={() => toggle(u, 'no-profit')} title="Add to owner's favourite list (0% markup)"><Icon name="star" size={15} /></button>
                          : <button className="btn btn-ghost btn-sm" onClick={() => toggle(u, 'no-profit')} title="Remove from favourite list (no notification to user)"><Icon name="ban" size={15} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {edit && (
        <Modal onClose={() => setEdit(null)} title={`Adjust balance — ${edit.user.email}`}>
          <div className="muted" style={{ fontSize: '0.9rem', marginBottom: 12 }}>
            Current balance: <b style={{ color: 'var(--text)' }}>{fmtInr(edit.user.wallet_balance)}</b>
          </div>
          <form onSubmit={adjust}>
            <label className="label">Amount (INR, signed)</label>
            <input className="input" type="number" step="any" value={edit.amount}
              onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
              placeholder="e.g. 500 or -100" autoFocus />
            <p className="faint" style={{ fontSize: '0.82rem', marginTop: 6 }}>Positive adds funds, negative deducts. A ledger entry is recorded either way.</p>
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Apply'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}