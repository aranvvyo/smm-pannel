import { useState, useEffect, useRef } from 'react';
import { get, post } from '../../api.js';
import { useToast, timeAgo, Empty, Icon } from '../../ui.jsx';

const ICON = { admin: 'star', order: 'rocket', deposit: 'coins', account: 'shield', coupon: 'ticket', ticket: 'support' };

export default function Notifications() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const marked = useRef(false);

  // Opening the panel marks the unread set as read (persisted via read_at in
  // the DB, so it survives refresh + a new device). The badge bus below tells
  // the navbar to clear its dot immediately instead of waiting for the poll.
  useEffect(() => {
    (async () => {
      const d = await get('/api/notifications').catch(() => ({ notifications: [], unread: 0 }));
      const list = d.notifications || [];
      setItems(list);
      setLoaded(true);
      if (!marked.current && list.some((n) => !n.read)) {
        marked.current = true;
        try { await post('/api/notifications/read-all', {}); } catch { /* never block */ }
        setItems((cur) => cur.map((n) => ({ ...n, read: true })));
        window.dispatchEvent(new CustomEvent('instasmm:notifs-read'));
      }
    })();
  }, []);

  const markAll = async () => {
    marked.current = true;
    await post('/api/notifications/read-all', {});
    setItems(items.map((n) => ({ ...n, read: true })));
    window.dispatchEvent(new CustomEvent('instasmm:notifs-read'));
    toast('All marked as read', 'success');
  };

  const markOne = async (id) => {
    await post(`/api/notifications/${id}/read`, {});
    setItems(items.map((n) => (n.id === id ? { ...n, read: true } : n)));
    window.dispatchEvent(new CustomEvent('instasmm:notifs-read'));
  };

  return (
    <>
      <h1 className="page-title">Notifications</h1>
      <p className="page-sub">Order updates, deposits, offers and account alerts.</p>

      {loaded && items.length === 0 ? (
        <div className="card"><Empty icon="bell" text="No notifications yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {items.map((n) => (
            <div key={n.id} className="flex" style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--border-soft)',
              background: n.read ? 'transparent' : 'rgba(16,185,129,0.06)',
              cursor: n.read ? 'default' : 'pointer',
            }} onClick={() => !n.read && markOne(n.id)}>
              <span className="notif-icon"><Icon name={ICON[n.type] || 'bell'} size={19} stroke={1.8} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex between">
                  <b>{n.title}</b>
                  <span className="faint" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{timeAgo(n.created_at)}</span>
                </div>
                <div className="muted" style={{ fontSize: '0.9rem' }}>{n.body}</div>
              </div>
              {!n.read && <span className="dot" style={{ background: 'var(--accent)', minWidth: 8, minHeight: 8 }} />}
            </div>
          ))}
        </div>
      )}
      {loaded && items.length > 0 && (
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button className="btn btn-ghost btn-sm" onClick={markAll}>Mark all read</button>
        </div>
      )}
    </>
  );
}