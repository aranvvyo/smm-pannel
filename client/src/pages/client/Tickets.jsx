import { useState, useEffect } from 'react';
import { get, post } from '../../api.js';
import { useToast, dateStr, Empty, Icon } from '../../ui.jsx';

const TS = {
  open: ['Open', 'badge-info'],
  pending: ['Waiting for you', 'badge-warn'],
  closed: ['Closed', 'badge-muted'],
};

export default function Tickets() {
  const toast = useToast();
  const [tickets, setTickets] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [form, setForm] = useState({ subject: '', order_id: '', body: '' });
  const [err, setErr] = useState('');
  const [channels, setChannels] = useState({ email: '', whatsapp: '', telegram: '', phone: '' });

  const load = async () => {
    const d = await get('/api/tickets');
    setTickets(d.tickets); setLoaded(true);
    // Our OWN support channels (configured by the admin) — suppliers are never shown.
    const s = await get('/api/support').catch(() => ({ channels: {} }));
    setChannels(s.channels || {});
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!form.subject.trim() || !form.body.trim()) { setErr('Subject and message are required.'); return; }
    setErr('');
    try {
      const d = await post('/api/tickets', {
        subject: form.subject, body: form.body, order_id: form.order_id ? Number(form.order_id) : null,
      });
      toast('Ticket opened', 'success');
      setForm({ subject: '', order_id: '', body: '' });
      setTickets([d.ticket, ...tickets]);
    } catch (x) { setErr(x.message); }
  };

  const reply = async (id) => {
    const body = (drafts[id] || '').trim();
    if (!body) return;
    const d = await post(`/api/tickets/${id}/reply`, { body });
    setTickets(tickets.map((t) => (t.id === id ? d.ticket : t)));
    setDrafts({ ...drafts, [id]: '' });
    toast('Reply sent', 'success');
  };

  const toggle = (id) => setExpanded(expanded === id ? null : id);

  return (
    <>
      <h1 className="page-title">Support</h1>
      <p className="page-sub">Need help? Open a ticket and attach the order ID — we’ll respond here.</p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <div className="card" style={{ alignSelf: 'start' }}>
          <h3 style={{ marginBottom: 4 }}>Open a new ticket</h3>
          <form onSubmit={create}>
            <label className="label">Subject</label>
            <input className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Order not delivered" />
            <label className="label">Order ID <span className="faint">(optional — attach a problematic order)</span></label>
            <input className="input" value={form.order_id} onChange={(e) => setForm({ ...form, order_id: e.target.value })} placeholder="e.g. 12" type="number" />
            <label className="label">Message</label>
            <textarea className="textarea" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Describe the issue…" />
            {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }}>Open Ticket</button>
          </form>
        </div>

        {/* Reach us directly — InstaSMM's own channels only (Task 9). */}
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>Direct contact</h3>
          <p className="faint" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
            Prefer a quick chat? Reach InstaSMM support directly.
          </p>
          <div className="stack" style={{ gap: 10 }}>
            {channels.email && (
              <a className="flex" style={{ gap: 10, color: 'var(--text)' }} href={`mailto:${channels.email}`}>
                <span className="side-icon"><Icon name="mail" size={17} stroke={1.8} /></span>
                <span className="muted" style={{ wordBreak: 'break-all' }}>{channels.email}</span>
              </a>
            )}
            {channels.whatsapp && (
              <a className="flex" style={{ gap: 10, color: 'var(--text)' }} href={`https://wa.me/${channels.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer">
                <span className="side-icon"><Icon name="phone" size={17} stroke={1.8} /></span>
                <span className="muted">WhatsApp {channels.whatsapp}</span>
              </a>
            )}
            {channels.telegram && (
              <a className="flex" style={{ gap: 10, color: 'var(--text)' }} href={`https://t.me/${channels.telegram.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer">
                <span className="side-icon"><Icon name="send" size={17} stroke={1.8} /></span>
                <span className="muted">{channels.telegram}</span>
              </a>
            )}
            {channels.phone && (
              <div className="flex" style={{ gap: 10 }}>
                <span className="side-icon"><Icon name="phone" size={17} stroke={1.8} /></span>
                <span className="muted">{channels.phone}</span>
              </div>
            )}
            {!channels.email && !channels.whatsapp && !channels.telegram && !channels.phone && (
              <p className="faint" style={{ fontSize: '0.88rem' }}>Contact details are set up soon. Until then, open a ticket above.</p>
            )}
          </div>
        </div>

        <div>
          {loaded && tickets.length === 0 ? (
            <div className="card"><Empty icon="ticket" text="No tickets yet." /></div>
          ) : tickets.map((t) => {
            const [label, cls] = TS[t.status] || [t.status, 'badge-muted'];
            return (
              <div key={t.id} className="card mb" style={{ padding: 0, overflow: 'hidden' }}>
                <button onClick={() => toggle(t.id)} className="flex between"
                  style={{ width: '100%', padding: '16px 18px', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                  <div>
                    <b>{t.subject}</b>
                    <div className="faint" style={{ fontSize: '0.82rem' }}>
                      {t.order_ref ? <>Order <span className="mono" style={{ color: 'var(--info)' }}>{t.order_ref}</span></> : 'No order attached'}
                      {' · '}{dateStr(t.created_at)} · {t.replies.length} reply{t.replies.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <span className={`badge ${cls}`}>{label}</span>
                </button>
                {expanded === t.id && (
                  <div style={{ padding: '6px 18px 18px', borderTop: '1px solid var(--border-soft)' }}>
                    {t.replies.map((r) => (
                      <div key={r.id} className="mt">
                        <div className={`badge ${r.sender_role === 'admin' ? 'badge-b' : 'badge-muted'} mb`} style={{ marginBottom: 4 }}>
                          {r.sender_role === 'admin' ? 'Support (admin)' : 'You'}
                        </div>
                        <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div>
                        <div className="faint" style={{ fontSize: '0.78rem', marginTop: 2 }}>{dateStr(r.created_at)}</div>
                      </div>
                    ))}
                    {t.status !== 'closed' && (
                      <div className="flex mt" style={{ marginTop: 14 }}>
                        <input className="input" value={drafts[t.id] || ''}
                          onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
                          placeholder="Write a reply…" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); reply(t.id); } }} />
                        <button className="btn btn-primary btn-sm" onClick={() => reply(t.id)}>Send</button>
                      </div>
                    )}
                    {t.status === 'closed' && <p className="faint" style={{ fontSize: '0.85rem', marginTop: 12 }}>Ticket closed — open a new one if you need more help.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}