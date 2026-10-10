import { useEffect, useState } from 'react';
import { get, put } from '../../api.js';
import { useToast, Modal } from '../../ui.jsx';

// Independent maintenance switches for INR and crypto deposits. The switch shows
// the SERVER state. Local edits are only sent when the admin clicks Save, and
// every save carries the version it was based on, so a stale view is refused.
const LABELS = { inr: 'INR deposits', crypto: 'Crypto deposits' };

export default function DepositMaintenanceCard() {
  const toast = useToast();
  const [state, setState] = useState(null);          // { inr: {...}, crypto: {...} } from the server
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useState({});          // unsaved edits per method
  const [saving, setSaving] = useState({});          // in-flight flag per method
  const [saveError, setSaveError] = useState({});
  const [confirm, setConfirm] = useState(null);      // method awaiting confirmation

  const load = async () => {
    try {
      const d = await get('/api/admin/deposit-maintenance');
      setState(d.maintenance); setLoadError('');
    } catch (e) {
      setLoadError(e.message || 'Could not load deposit maintenance settings.');
    }
  };
  useEffect(() => { load(); }, []);

  const draftOf = (m) => drafts[m] ?? { enabled: state[m].enabled, message: state[m].message };

  const doSave = async (m) => {
    if (saving[m]) return;                           // no duplicate submits
    const d = draftOf(m);
    setSaving((s) => ({ ...s, [m]: true }));
    setSaveError((s) => ({ ...s, [m]: '' }));
    try {
      const out = await put(`/api/admin/deposit-maintenance/${m}`, {
        enabled: Boolean(d.enabled),
        message: String(d.message || ''),
        expected_version: state[m].version,
      });
      setState((s) => ({ ...s, [m]: out.maintenance }));
      setDrafts((s) => { const n = { ...s }; delete n[m]; return n; });
      toast(`${LABELS[m]}: ${out.maintenance.enabled ? 'maintenance mode on' : 'accepting deposits'} — saved.`);
    } catch (e) {
      if (e.code === 'STALE_VERSION' && e.data?.maintenance) {
        setState((s) => ({ ...s, [m]: e.data.maintenance }));
        setDrafts((s) => { const n = { ...s }; delete n[m]; return n; });
      }
      setSaveError((s) => ({ ...s, [m]: e.message || 'Failed to save.' }));
      toast(e.message || 'Failed to save.', 'error');
    } finally {
      setSaving((s) => ({ ...s, [m]: false }));
    }
  };

  const requestSave = (m) => {
    const d = draftOf(m);
    // Turning maintenance ON stops new deposits: ask first.
    if (d.enabled && !state[m].enabled) setConfirm(m);
    else doSave(m);
  };

  if (loadError) return <div className="card" role="alert"><b>Deposit maintenance</b><p className="faint">{loadError}</p></div>;
  if (!state) return <div className="card"><p className="faint">Loading deposit maintenance…</p></div>;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Deposit maintenance</h3>
      <p className="faint" style={{ marginTop: 0 }}>
        Turning maintenance on stops NEW deposit requests. Existing deposits, crypto payments already on their way,
        and admin review are not affected.
      </p>
      {['inr', 'crypto'].map((m) => {
        const s = state[m];
        const d = draftOf(m);
        const dirty = d.enabled !== s.enabled || d.message !== s.message;
        const status = saving[m] ? 'Saving'
          : saveError[m] ? 'Failed to Save'
          : s.enabled ? 'Maintenance mode' : 'Accepting deposits';
        return (
          <div key={m} style={{ borderTop: '1px solid var(--border, #e5e5e5)', padding: '12px 0' }}>
            <div className="flex between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <b>{LABELS[m]}</b>{' '}
                <span className="badge" data-status={status}>{status}</span>
              </div>
              <label className="flex" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" role="switch" aria-label={`${LABELS[m]} maintenance`}
                  checked={d.enabled} disabled={saving[m]}
                  onChange={(e) => setDrafts((x) => ({ ...x, [m]: { ...d, enabled: e.target.checked } }))} />
                <span>{d.enabled ? 'Pause new deposits' : 'Accepting deposits'}</span>
              </label>
            </div>
            <label style={{ display: 'block', marginTop: 8 }}>
              <span className="faint" style={{ fontSize: '0.8rem' }}>Message shown to customers (plain text, max 200 characters)</span>
              <textarea className="input" rows={2} maxLength={200} value={d.message} disabled={saving[m]}
                onChange={(e) => setDrafts((x) => ({ ...x, [m]: { ...d, message: e.target.value } }))}
                style={{ width: '100%', marginTop: 4, boxSizing: 'border-box', minWidth: 0 }} />
            </label>
            <div className="flex between" style={{ gap: 12, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
              <span className="faint" style={{ fontSize: '0.8rem', minWidth: 0 }}>
                {s.updated_at ? `Last changed ${new Date(s.updated_at).toLocaleString('en-IN')}${s.updated_by ? ` by ${s.updated_by}` : ''}` : 'Never changed (default)'}
              </span>
              <button type="button" className="btn btn-primary" disabled={!dirty || saving[m]}
                onClick={() => requestSave(m)}>
                {saving[m] ? 'Saving…' : 'Save'}
              </button>
            </div>
            {saveError[m] && <div role="alert" className="faint" style={{ color: 'var(--danger, #b00020)', marginTop: 6 }}>{saveError[m]}</div>}
          </div>
        );
      })}
      {confirm && (
        <Modal title={`Turn on maintenance for ${LABELS[confirm]}?`} onClose={() => setConfirm(null)}>
          <p>New {LABELS[confirm].toLowerCase()} requests will be blocked for customers. Existing deposits are not changed.</p>
          <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => { const m = confirm; setConfirm(null); doSave(m); }}>
              Turn on maintenance
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
