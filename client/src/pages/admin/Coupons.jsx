import { useEffect, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import { useToast, fmtInr, timeAgo, Modal, Empty, Icon } from '../../ui.jsx';

const blank = { code: '', type: 'percent', value: '', min_order: '', starts_at: '', expires_at: '', usage_limit: '', active: 1 };

export default function AdminCoupons() {
  const toast = useToast();
  const [coupons, setCoupons] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState(null);

  const load = async () => { setCoupons((await get('/api/admin/coupons')).coupons); setLoaded(true); };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    const b = { ...edit };
    if (b.starts_at === '') b.starts_at = undefined;
    if (b.expires_at === '') b.expires_at = undefined;
    if (b.usage_limit === '') b.usage_limit = undefined;
    b.active = Number(b.active);
    try {
      if (edit.id) {
        await patch(`/api/admin/coupons/${edit.id}`, b);
        toast('Coupon updated.', 'success');
      } else {
        await post('/api/admin/coupons', b);
        toast('Coupon created.', 'success');
      }
      setEdit(null); load();
    } catch (x) { toast(x.message, 'error'); }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete coupon ${c.code}?`)) return;
    try { await del(`/api/admin/coupons/${c.id}`); toast('Deleted.', 'success'); load(); }
    catch (x) { toast(x.message, 'error'); }
  };

  const openEdit = (c) => setEdit({
    id: c.id, code: c.code, type: c.type, value: c.value,
    min_order: c.min_order_inr / 100,
    starts_at: c.starts_at ? new Date(c.starts_at).toISOString().slice(0, 16) : '',
    expires_at: c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 16) : '',
    usage_limit: c.usage_limit ?? '', active: c.active,
  });

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 4 }}>
        <div>
          <h1 className="page-title">Coupons</h1>
          <p className="page-sub">Smart time-based discounts. The engine never lets a coupon take you below provider cost.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ ...blank })}>+ New coupon</button>
      </div>

      {loaded && coupons.length === 0 ? (
        <div className="card"><Empty icon="ticket" text="No coupons yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Code</th><th>Type</th><th>Value</th><th>Min order</th><th>Used</th><th>Window</th><th>Status</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {coupons.map((c) => {
                  const now = Date.now();
                  const expired = c.expires_at && c.expires_at < now;
                  const notStarted = c.starts_at && c.starts_at > now;
                  return (
                    <tr key={c.id}>
                      <td><b className="mono" style={{ color: 'var(--info)' }}>{c.code}</b></td>
                      <td>{c.type === 'percent' ? '% off' : 'INR off'}</td>
                      <td>{c.type === 'percent' ? `${c.value}%` : fmtInr(c.value)}</td>
                      <td className="faint">{c.min_order_inr > 0 ? fmtInr(c.min_order_inr) : '—'}</td>
                      <td>{c.used_count}{c.usage_limit ? ` / ${c.usage_limit}` : ''}</td>
                      <td className="faint" style={{ fontSize: '0.82rem' }}>
                        {c.starts_ist ? `From ${c.starts_ist.split(',')[0]}` : 'Anytime'}
                        {c.expires_ist ? <div>To {c.expires_ist.split(',')[0]}</div> : <div>No expiry</div>}
                      </td>
                      <td>
                        {c.active === 0 ? <span className="badge badge-muted">Off</span>
                          : expired ? <span className="badge badge-danger">Expired</span>
                            : notStarted ? <span className="badge badge-warn">Upcoming</span>
                              : <span className="badge badge-success">Active</span>}
                      </td>
                      <td className="faint">{timeAgo(c.created_at)}</td>
                      <td>
                        <div className="flex">
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(c)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => remove(c)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {edit && (
        <Modal onClose={() => setEdit(null)} title={edit.id ? `Edit — ${edit.code}` : 'New coupon'}>
          <form onSubmit={save} className="stack">
            <div className="grid grid-2">
              <div>
                <label className="label">Code</label>
                <input className="input" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} required />
              </div>
              <div>
                <label className="label">Type</label>
                <select className="select" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                  <option value="percent">Percent %</option>
                  <option value="fixed_inr">Fixed ₹ (INR)</option>
                </select>
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">{edit.type === 'percent' ? 'Percent off' : 'Fixed amount (INR)'}</label>
                <input className="input" type="number" min="0" step="any" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} required />
              </div>
              <div>
                <label className="label">Min order (INR)</label>
                <input className="input" type="number" min="0" step="any" value={edit.min_order} onChange={(e) => setEdit({ ...edit, min_order: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Starts</label>
                <input className="input" type="datetime-local" value={edit.starts_at} onChange={(e) => setEdit({ ...edit, starts_at: e.target.value })} />
              </div>
              <div>
                <label className="label">Expires</label>
                <input className="input" type="datetime-local" value={edit.expires_at} onChange={(e) => setEdit({ ...edit, expires_at: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Usage limit <span className="faint">(blank = unlimited)</span></label>
                <input className="input" type="number" min="1" value={edit.usage_limit} onChange={(e) => setEdit({ ...edit, usage_limit: e.target.value })} />
              </div>
              <div>
                <label className="label">Status</label>
                <select className="select" value={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.value })}>
                  <option value={1}>Active</option>
                  <option value={0}>Disabled</option>
                </select>
              </div>
            </div>
            <p className="faint" style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <span style={{ flexShrink: 0 }}><Icon name="info" size={14} style={{ verticalAlign: '-2px' }} /></span>
              Coupon discounts are clamped so the final price never drops below the provider base cost —
              the exact math lives only on the server.
            </p>
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary">{edit.id ? 'Save changes' : 'Create coupon'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}