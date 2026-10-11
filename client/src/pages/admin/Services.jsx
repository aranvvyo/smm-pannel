import { useEffect, useState } from 'react';
import { get, post, patch } from '../../api.js';
import { useToast, fmtInr, Modal, Empty } from '../../ui.jsx';
import { fmtRatePer1k } from '../../lib/serviceFormat.js';

export default function AdminServices() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [edit, setEdit] = useState(null);   // editing service
  const [creating, setCreating] = useState(false);
  const [global, setGlobal] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [svc, pr] = await Promise.all([get('/api/admin/services'), get('/api/admin/providers')]);
    setData(svc); setProviders(pr.providers);
  };
  useEffect(() => { load(); }, []);

  if (!data) return <div className="faint">Loading…</div>;
  const { services, categories } = data;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const b = { ...edit };
      b.min = Number(b.min); b.max = Number(b.max); b.provider_rate = Number(b.provider_rate);
      if (b.admin_rate === '' || b.admin_rate == null) delete b.admin_rate;      // blank = auto from markup
      else b.admin_rate = Number(b.admin_rate);
      b.markup_value = Number(b.markup_value);
      b.status = Number(b.status);
      b.refill = Number(b.refill || 0);
      b.cancel = Number(b.cancel || 0);
      const d = await patch(`/api/admin/services/${b.id}`, b);
      toast('Service updated.', 'success');
      setEdit(null);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const b = { ...creating };
      b.provider_id = Number(b.provider_id); b.category_id = Number(b.category_id);
      b.provider_rate = Number(b.provider_rate); b.markup_value = Number(b.markup_value || 25);
      b.min = Number(b.min || 1); b.max = Number(b.max || 999999);
      const d = await post('/api/admin/services', b);
      toast('Service created — admin rate ' + fmtInr(Math.round(d.admin_rate)) + '/1k.', 'success');
      setCreating(false);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const setGlobalMarkup = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await post('/api/admin/markup/global', { markup_type: global.markup_type, markup_value: Number(global.markup_value) });
      toast(`Applied markup to ${d.updated} services.`, 'success');
      setGlobal(false); load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 4 }}>
        <div>
          <h1 className="page-title">Services</h1>
          <p className="page-sub">{services.length} services · provider cost vs admin sell price (per 1000).</p>
        </div>
        <div className="flex">
          <button className="btn btn-outline btn-sm" onClick={() => setGlobal({ markup_type: 'percent', markup_value: 25 })}>Global markup</button>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating({ name: '', description: '', type: 'Default', min: 1, max: 999999, provider_rate: '', markup_type: 'percent', markup_value: 25, refill: 0, cancel: 0, status: 1 })}>+ New service</button>
        </div>
      </div>

      {services.length === 0 ? (
        <div className="card"><Empty icon="package" text="No services yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Service</th><th>Category</th><th>Provider</th><th>Base rate</th><th>Sell rate</th><th>Markup</th><th>Range</th><th>Capabilities</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {services.map((s) => {
                  const gain = s.admin_rate - s.provider_rate;
                  const pct = s.provider_rate > 0 ? Math.round((gain / s.provider_rate) * 100) : 0;
                  return (
                    <tr key={s.id}>
                      <td><b>{s.name}</b>{s.description && <div className="faint" style={{ fontSize: '0.78rem', maxWidth: 220 }}>{s.description}</div>}</td>
                      <td>{s.category_name}</td>
                      <td className="faint">{s.provider_name}</td>
                      <td>{fmtRatePer1k(s.provider_rate)} <span className="faint">/ 1k</span></td>
                      <td>
                        <b>{fmtRatePer1k(s.admin_rate)}</b> <span className="faint">/ 1k</span>{' '}
                        <span className="faint" style={{ fontSize: '0.78rem' }}>(gain {gain < 0 ? '−' : gain > 0 ? '+' : ''}{gain === 0 ? '₹0' : fmtRatePer1k(Math.abs(gain))})</span>
                        {s.price_status && s.price_status !== 'ok' && (
                          <div>
                            <span
                              className={`badge ${s.price_status === 'review' ? 'badge-warn' : 'badge-danger'}`}
                              title={s.price_reason || ''}
                              style={{ marginTop: 4 }}>
                              {s.price_status === 'invalid' ? 'Invalid price'
                                : s.price_status === 'unorderable' ? 'Rounds to ₹0'
                                : 'Review price'}
                            </span>
                          </div>
                        )}
                      </td>
                      <td><span className="badge badge-b">{pct}%</span></td>
                      <td className="faint">{s.min.toLocaleString()}–{s.max > 999999 ? '∞' : s.max.toLocaleString()}</td>
                      <td>
                        <span className="faint" style={{ fontSize: '0.78rem' }}>{s.type || 'Default'}</span>
                        {Number(s.refill) === 1 && <span className="badge badge-info" style={{ marginLeft: 5 }}>Refill</span>}
                        {Number(s.cancel) === 1 && <span className="badge badge-b" style={{ marginLeft: 5 }}>Cancel</span>}
                      </td>
                      <td>{s.status === 1 ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Off</span>}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...s })}>Edit</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {edit && (
        <Modal onClose={() => setEdit(null)} title={`Edit — ${edit.name}`}>
          <form onSubmit={save} className="stack">
            <label className="label">Name</label>
            <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <div className="grid grid-2">
              <div>
                <label className="label">Provider rate (per 1000)</label>
                <input className="input" type="number" value={edit.provider_rate} onChange={(e) => setEdit({ ...edit, provider_rate: e.target.value })} />
              </div>
              <div>
                <label className="label">Sell rate (per 1000)</label>
                <input className="input" type="number" step="any" value={edit.admin_rate} onChange={(e) => setEdit({ ...edit, admin_rate: e.target.value })}
                  placeholder={String(Math.round(edit.admin_rate))} />
                <p className="faint" style={{ fontSize: '0.78rem', marginTop: 4 }}>Leave = auto from markup.</p>
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Markup type</label>
                <select className="select" value={edit.markup_type} onChange={(e) => setEdit({ ...edit, markup_type: e.target.value })}>
                  <option value="percent">Percent %</option>
                  <option value="fixed">Fixed (INR/1000)</option>
                </select>
              </div>
              <div>
                <label className="label">Markup value</label>
                <input className="input" type="number" value={edit.markup_value} onChange={(e) => setEdit({ ...edit, markup_value: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Min qty</label>
                <input className="input" type="number" value={edit.min} onChange={(e) => setEdit({ ...edit, min: e.target.value })} />
              </div>
              <div>
                <label className="label">Max qty</label>
                <input className="input" type="number" value={edit.max} onChange={(e) => setEdit({ ...edit, max: e.target.value })} />
              </div>
            </div>
            <label className="label">Service type</label>
            <input className="input" value={edit.type || ''} onChange={(e) => setEdit({ ...edit, type: e.target.value })}
              placeholder="Default / Comments / Paged…" />
            <div className="grid grid-2">
              <div>
                <label className="label">Refill support (provider)</label>
                <select className="select" value={String(Number(edit.refill) === 1 ? 1 : 0)} onChange={(e) => setEdit({ ...edit, refill: e.target.value })}>
                  <option value={1}>Yes</option>
                  <option value={0}>No</option>
                </select>
              </div>
              <div>
                <label className="label">Cancel support (provider)</label>
                <select className="select" value={String(Number(edit.cancel) === 1 ? 1 : 0)} onChange={(e) => setEdit({ ...edit, cancel: e.target.value })}>
                  <option value={1}>Yes</option>
                  <option value={0}>No</option>
                </select>
              </div>
            </div>
            <label className="label">Status</label>
            <select className="select" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
              <option value={1}>Active</option>
              <option value={0}>Hidden</option>
            </select>
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save service'}</button>
            </div>
          </form>
        </Modal>
      )}

      {creating && (
        <Modal onClose={() => setCreating(false)} title="New service">
          <form onSubmit={create} className="stack">
            <label className="label">Name</label>
            <input className="input" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} required />
            <div className="grid grid-2">
              <div>
                <label className="label">Provider</label>
                <select className="select" value={creating.provider_id || ''} onChange={(e) => setCreating({ ...creating, provider_id: e.target.value })} required>
                  <option value="">— Select —</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.adapter})</option>)}
                </select>
              </div>
              <div>
                <label className="label">Category</label>
                <select className="select" value={creating.category_id || ''} onChange={(e) => setCreating({ ...creating, category_id: e.target.value })} required>
                  <option value="">—</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <label className="label">Provider rate (per 1000)</label>
            <input className="input" type="number" step="any" value={creating.provider_rate} onChange={(e) => setCreating({ ...creating, provider_rate: e.target.value })} required />
            <div className="grid grid-2">
              <div>
                <label className="label">Markup type</label>
                <select className="select" value={creating.markup_type} onChange={(e) => setCreating({ ...creating, markup_type: e.target.value })}>
                  <option value="percent">Percent %</option>
                  <option value="fixed">Fixed (INR/1000)</option>
                </select>
              </div>
              <div>
                <label className="label">Markup value</label>
                <input className="input" type="number" value={creating.markup_value} onChange={(e) => setCreating({ ...creating, markup_value: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Min</label>
                <input className="input" type="number" value={creating.min} onChange={(e) => setCreating({ ...creating, min: e.target.value })} />
              </div>
              <div>
                <label className="label">Max</label>
                <input className="input" type="number" value={creating.max} onChange={(e) => setCreating({ ...creating, max: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-2">
              <div>
                <label className="label">Refill support (provider)</label>
                <select className="select" value={String(Number(creating.refill) === 1 ? 1 : 0)} onChange={(e) => setCreating({ ...creating, refill: e.target.value })}>
                  <option value={1}>Yes</option>
                  <option value={0}>No</option>
                </select>
              </div>
              <div>
                <label className="label">Cancel support (provider)</label>
                <select className="select" value={String(Number(creating.cancel) === 1 ? 1 : 0)} onChange={(e) => setCreating({ ...creating, cancel: e.target.value })}>
                  <option value={1}>Yes</option>
                  <option value={0}>No</option>
                </select>
              </div>
            </div>
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create service'}</button>
            </div>
          </form>
        </Modal>
      )}

      {global && (
        <Modal onClose={() => setGlobal(false)} title="Set global markup">
          <form onSubmit={setGlobalMarkup} className="stack">
            <label className="label">Markup type</label>
            <select className="select" value={global.markup_type} onChange={(e) => setGlobal({ ...global, markup_type: e.target.value })}>
              <option value="percent">Percent %</option>
              <option value="fixed">Fixed (INR/1000)</option>
            </select>
            <label className="label">Markup value</label>
            <input className="input" type="number" value={global.markup_value} onChange={(e) => setGlobal({ ...global, markup_value: e.target.value })} />
            <p className="faint" style={{ fontSize: '0.84rem' }}>Recomputes sell rate for <b>{services.length}</b> services from their provider base rates.</p>
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setGlobal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Applying…' : 'Apply to all'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}