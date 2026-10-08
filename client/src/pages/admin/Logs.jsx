import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Empty } from '../../ui.jsx';

const KIND = {
  login: ['Sign in', 'var(--success)'],
  admin_login: ['Admin sign in', 'var(--success)'],
  admin_logout: ['Admin sign out', 'var(--faint)'],
  logout: ['Sign out', 'var(--faint)'],
  register: ['Registered', 'var(--info)'],
  failed_login: ['Failed login', 'var(--danger)'],
  failed_admin_login: ['Failed admin login', 'var(--danger)'],
  blocked_admin_login: ['Blocked admin login', 'var(--danger)'],
  blocked_banned_login: ['Banned user login', 'var(--danger)'],
  ban: ['Ban', 'var(--danger)'],
  unban: ['Unban', 'var(--success)'],
  add_no_profit: ['Add no-profit', 'var(--warn)'],
  remove_no_profit: ['Remove no-profit', 'var(--faint)'],
  edit_service: ['Edit service', 'var(--info)'],
  global_markup: ['Global markup', 'var(--info)'],
  add_provider: ['Add provider', 'var(--info)'],
  edit_provider: ['Edit provider', 'var(--info)'],
  delete_provider: ['Delete provider', 'var(--danger)'],
  sync_services: ['Sync services', 'var(--info)'],
  cancel_order: ['Cancel order', 'var(--danger)'],
  refill_order: ['Refill order', 'var(--warn)'],
  create_coupon: ['Create coupon', 'var(--info)'],
  edit_coupon: ['Edit coupon', 'var(--info)'],
  manual_confirm_deposit: ['Manual deposit confirm', 'var(--success)'],
  verify_inr_deposit: ['Verify INR deposit', 'var(--success)'],
  deny_inr_deposit: ['Deny INR deposit', 'var(--danger)'],
  dismiss_deposit: ['Dismiss deposit', 'var(--danger)'],
  update_settings: ['Update settings', 'var(--warn)'],
};

export default function AdminLogs() {
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    get('/api/admin/logs?limit=200').then((d) => { setLogs(d.logs); setLoaded(true); });
  }, []);

  return (
    <>
      <h1 className="page-title">Audit Logs</h1>
      <p className="page-sub">Security events with IST timestamps and client IPs.</p>

      {loaded && logs.length === 0 ? (
        <div className="card"><Empty icon="shield" text="No logged events yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead><tr><th>Event</th><th>Email</th><th>IP</th><th>Detail</th><th>When (IST)</th></tr></thead>
              <tbody>
                {logs.map((l) => {
                  const [label, color] = KIND[l.action] || [l.action, 'var(--faint)'];
                  return (
                    <tr key={l.id}>
                      <td><span className="dot" style={{ background: color, marginRight: 8 }} />{label}</td>
                      <td className="mono" style={{ fontSize: '0.85rem' }}>{l.email || '—'}</td>
                      <td><code className="code">{l.ip || '—'}</code></td>
                      <td className="faint" style={{ maxWidth: 280, wordBreak: 'break-word' }}>{l.detail || '—'}</td>
                      <td className="faint">{l.created_ist}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}