import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, dateStr, Empty } from '../../ui.jsx';

const TS = {
  open: ['Open', 'badge-info'],
  pending: ['Waiting visitor', 'badge-warn'],
  closed: ['Closed', 'badge-muted'],
};

export default function AdminTickets() {
  const toast = useToast();
  const [tickets, setTickets] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('ALL');
  const [expanded, setExpanded] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (st = status) => {
    setTickets((await get(`/api/admin/tickets?status=${st}`)).tickets);
    setLoaded(true);
  };
  useEffect(() => { load('ALL'); }, []);
  const setSt = (s) => { setStatus(s); load(s); };

  const sendReply = async (t) => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      const d = await post(`/api/admin/tickets/${t.id}/reply`, { body: reply });
      setTickets(tickets.map((x) => (x.id === t.id ? d.ticket : x)));
      setReply('');
      toast('Reply sent.', 'success');
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const setTicketStatus = async (t, st) => {
    try {
      const d = await post(`/api/admin/tickets/${t.id}/status`, { status: st });
      setTickets(tickets.map((x) => (x.id === t.id ? d.ticket : x)));
      toast(`Ticket marked ${st}.`, 'success');
    } catch (x) { toast(x.message, 'error'); }
  };

  return (
    <>
      <h1 className="page-title">Support Tickets</h1>
      <p className="page-sub">Reply to your clients — they’re notified instantly in the panel.</p>

      <div className="filter-chips">
        {['ALL', 'open', 'pending', 'closed'].map((s) => (
          <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setSt(s)}>
            {s === 'ALL' ? 'All' : s}
          </button>
        ))}
      </div>

      {loaded && tickets.length === 0 ? (
        <div className="card"><Empty icon="ticket" text="No tickets." /></div>
      ) : tickets.map((t) => (
        <div key={t.id} className="card mb" style={{ padding: 0, overflow: 'hidden' }}>
          <button onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="flex between"
            style={{ width: '100%', padding: '14px 18px', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
            <div>
              <b>{t.subject}</b>
              <div className="faint" style={{ fontSize: '0.82rem' }}>
                {t.email}{t.order_ref ? ` · order ${t.order_ref}` : ''} · {dateStr(t.created_at)} · {t.replies.length} replies
              </div>
            </div>
            <div className="flex">
              <span className={`badge ${(TS[t.status] || ['', 'badge-muted'])[1]}`}>{t.status}</span>
            </div>
          </button>

          {expanded === t.id && (
            <div style={{ padding: '4px 18px 18px', borderTop: '1px solid var(--border-soft)' }}>
              {t.replies.map((r) => (
                <div key={r.id} className="mt">
                  <div className="flex between" style={{ marginBottom: 2 }}>
                    <span className={`badge ${r.sender_role === 'admin' ? 'badge-b' : 'badge-muted'}`}>
                      {r.sender_role === 'admin' ? 'Admin' : t.email}
                    </span>
                    <span className="faint" style={{ fontSize: '0.78rem' }}>{dateStr(r.created_at)}</span>
                  </div>
                  <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div>
                </div>
              ))}

              {t.status !== 'closed' && (
                <div className="flex mt" style={{ marginTop: 16 }}>
                  <textarea className="textarea" rows={2} value={reply}
                    onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" />
                  <button className="btn btn-primary" disabled={busy} onClick={() => sendReply(t)}>Send</button>
                </div>
              )}

              <div className="flex mt" style={{ marginTop: 14, gap: 8 }}>
                {t.status !== 'open' && <button className="btn btn-outline btn-sm" onClick={() => setTicketStatus(t, 'open')}>Mark open</button>}
                {t.status !== 'pending' && <button className="btn btn-outline btn-sm" onClick={() => setTicketStatus(t, 'pending')}>Mark waiting</button>}
                {t.status !== 'closed' && <button className="btn btn-danger btn-sm" onClick={() => setTicketStatus(t, 'closed')}>Close</button>}
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}