import { useEffect, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import { useToast, timeAgo, Modal, Empty, Icon } from '../../ui.jsx';

const EMPTY_FORM = () => ({
  name: '', adapter: 'smmpost', api_url: '', api_key: '',
  active: 1, currency: 'USD', markup_type: 'percent', markup_value: 25,
});

export default function AdminProviders() {
  const toast = useToast();
  const [providers, setProviders] = useState([]);
  const [adapters, setAdapters] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState({});   // id -> msg
  const [syncing, setSyncing] = useState(null);

  const load = async () => {
    const d = await get('/api/admin/providers');
    setProviders(d.providers); setAdapters(d.adapters);
  };
  useEffect(() => { load(); }, []);

  const save = async (e, isEdit) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isEdit) {
        const { id, ...b } = editing;
        await patch(`/api/admin/providers/${id}`, b);
        toast('Provider updated.', 'success');
        setEditing(null);
      } else {
        await post('/api/admin/providers', creating);
        toast('Provider added — API key stored server-side only.', 'success');
        setCreating(false);
      }
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete provider "${p.name}" and all its services?`)) return;
    try {
      await del(`/api/admin/providers/${p.id}`);
      toast('Provider deleted.', 'success');
      load();
    } catch (x) { toast(x.message, 'error'); }
  };

  const test = async (p) => {
    setTestResult((t) => ({ ...t, [p.id]: 'Testing connection…' }));
    try {
      const d = await post(`/api/admin/providers/${p.id}/test`, {});
      setTestResult((t) => ({ ...t, [p.id]: `Connection OK — balance ${d.balance} ${d.currency}` }));
      load();
    } catch (x) { setTestResult((t) => ({ ...t, [p.id]: x.message })); }
  };

  const sync = async (p) => {
    setSyncing(p.id);
    try {
      const d = await post(`/api/admin/providers/${p.id}/sync-services`, {});
      toast(d.message || `Synced ${d.pulled} services.`, 'success');
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setSyncing(null); }
  };

  const PForm = ({ form, setForm, onSubmit, title, isEdit }) => (
    <Modal onClose={() => { setCreating(false); setEditing(null); }} title={title}>
      <form onSubmit={onSubmit} className="stack">
        <label className="label">Name</label>
        <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Provider #1" />

        <label className="label">API URL <span className="faint">(smmpost)</span></label>
        <input className="input" value={form.api_url || ''} onChange={(e) => setForm({ ...form, api_url: e.target.value })} placeholder="https://themainsmmprovider.com/api/v2" />

        <label className="label">API key <span className="faint">(stored server-side, never shown again)</span></label>
        <input className="input" type="password" value={form.api_key || ''} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
          placeholder={isEdit ? '••••• (leave blank to keep the stored key)' : 'API key…'} />

        <div className="grid grid-2">
          <label className="label">Currency</label>
          <label className="label">Active / status</label>
          <select className="select" value={form.currency || 'USD'} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {['USD', 'INR', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" value={form.active === 0 ? 0 : 1} onChange={(e) => setForm({ ...form, active: Number(e.target.value) })}>
            <option value={1}>Active</option>
            <option value={0}>Paused</option>
          </select>

          <label className="label">Markup type</label>
          <label className="label">Markup value</label>
          <select className="select" value={form.markup_type} onChange={(e) => setForm({ ...form, markup_type: e.target.value })}>
            <option value="percent">Percent (%)</option>
            <option value="fixed">Fixed (per 1k)</option>
          </select>
          <input className="input" type="number" min={0} step="any" value={form.markup_value ?? ''}
            onChange={(e) => setForm({ ...form, markup_value: e.target.value })} />
        </div>
        <p className="faint" style={{ fontSize: '0.8rem' }}>
          New services synced from this provider get {form.markup_type === 'percent' ? `${form.markup_value}% added` : `+₹${form.markup_value} per 1k added`} to the supplier rate (falls back to the global setting if markup is 0). Existing per-service markups are never overwritten.
        </p>

        <div className="flex" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="btn btn-ghost" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 4 }}>
        <div>
          <h1 className="page-title">Providers</h1>
          <p className="page-sub">SMM provider accounts. API keys never leave the server.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(EMPTY_FORM())}>+ Add provider</button>
      </div>

      <div className="grid grid-2">
        {providers.length === 0 ? (
          <div className="card" style={{ gridColumn: '1 / -1' }}><Empty icon="plug" text="No providers yet — add one with Test Connection and Sync Services." /></div>
        ) : providers.map((p) => (
          <div key={p.id} className="card">
            <div className="flex between">
              <div className="flex">
                <span className="svc-icon" style={{ color: p.adapter === 'demo' ? 'var(--accent-2)' : 'var(--info)' }}>
                  <Icon name={p.adapter === 'demo' ? 'settings' : 'plug'} size={19} stroke={1.7} />
                </span>
                <div>
                  <b>{p.name}</b>
                  <div className="faint" style={{ fontSize: '0.8rem' }}>{p.adapter} · id {p.id} · {p.currency || 'USD'}</div>
                </div>
              </div>
              {p.active === 1 ? <span className="badge badge-success">Live</span> : <span className="badge badge-muted">Paused</span>}
            </div>

            <div className="stack mt" style={{ gap: 6 }}>
              <div className="flex between"><span className="row-label">API key</span>
                {p.has_api_key ? <span className="badge badge-b"><span className="dot" style={{ background: 'var(--success)' }} /> Stored</span> : <span className="badge badge-danger">Missing</span>}
              </div>
              {p.api_url_masked && <div className="flex between"><span className="row-label">Endpoint</span><span className="mono faint">{p.api_url_masked}</span></div>}
              <div className="flex between"><span className="row-label">Balance</span>
                <b>{p.balance != null ? `${p.balance} ${p.currency || ''}` : '—'}</b></div>
              <div className="flex between"><span className="row-label">Service count</span>
                <span className="faint">{p.service_count != null ? p.service_count : '—'} in catalog</span></div>
              <div className="flex between"><span className="row-label">Markup</span>
                <span className="faint">{p.markup_type === 'fixed' ? `+₹${p.markup_value} / 1k` : `${p.markup_value}%`}</span></div>
              <div className="flex between"><span className="row-label">Last sync</span>
                <span className="faint">{p.last_sync_at ? timeAgo(p.last_sync_at) : 'never'}</span></div>
              <div className="flex between"><span className="row-label">Last success</span>
                <span className="faint">{p.last_success_at ? timeAgo(p.last_success_at) : '—'}</span></div>
              {p.last_error && (
                <div className="field-error" style={{ marginTop: 4 }}><Icon name="alert" size={13} /> {p.last_error}</div>
              )}
            </div>

            {testResult[p.id] && <div className="muted mt" style={{ fontSize: '0.85rem' }}>{testResult[p.id]}</div>}

            <div className="flex wrap mt" style={{ marginTop: 16, gap: 8 }}>
              <button className="btn btn-outline btn-sm" onClick={() => test(p)}>Test balance</button>
              <button className="btn btn-outline btn-sm" onClick={() => sync(p)} disabled={syncing === p.id}>
                {syncing === p.id ? 'Syncing…' : 'Sync services'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...p })}>Edit</button>
              <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => remove(p)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {creating && <PForm form={creating} setForm={setCreating} onSubmit={(e) => save(e, false)} title="Add provider" isEdit={false} />}
      {editing && <PForm form={editing} setForm={setEditing} onSubmit={(e) => save(e, true)} title={`Edit — ${editing.name}`} isEdit />}
    </>
  );
}