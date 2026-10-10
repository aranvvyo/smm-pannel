import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr } from '../../ui.jsx';
import DepositMaintenanceCard from './DepositMaintenanceCard.jsx';

export default function AdminSettings() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [mode, setMode] = useState('');
  const [apirone, setApirone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  // Write-only credential inputs — never prefilled, never returned by the API.
  const [apiForm, setApiForm] = useState({ account_id: '', transfer_key: '', webhook_token: '' });

  const load = async () => {
    const d = await get('/api/admin/settings');
    setS(d.settings); setMode(d.payment_mode); setApirone(d.apirone);
  };
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  const setNum = (k) => (e) => setS({ ...s, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        exchange_rate: Number(s.exchange_rate),
        deposit_timeout_hours: Number(s.deposit_timeout_hours),
        demo_auto_confirm: String(s.demo_auto_confirm),
        demo_confirm_seconds: Number(s.demo_confirm_seconds),
        global_markup_type: String(s.global_markup_type || 'percent'),
        global_markup_value: Number(s.global_markup_value ?? 25),
        // Our own support channels — shown to clients on the Support page. Never
        // a supplier's contacts.
        support_email: String(s.support_email || ''),
        support_whatsapp: String(s.support_whatsapp || ''),
        support_telegram: String(s.support_telegram || ''),
        support_phone: String(s.support_phone || ''),
      };
      const d = await post('/api/admin/settings', body);
      toast(`Settings saved (${d.changed} changed).`, 'success');
      if (d.apirone) setApirone(d.apirone);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  // Apirone credentials are write-only — never prefilled from the API. Blank
  // fields mean "keep the current value". Entering new ones switches the panel
  // to live Apirone immediately.
  const saveApirone = async () => {
    setBusy(true);
    try {
      const body = {};
      const id = apiForm.account_id.trim();
      const tk = apiForm.transfer_key.trim();
      const wt = apiForm.webhook_token.trim();
      if (id) body.apirone_account_id = id;
      if (tk) body.apirone_transfer_key = tk;
      if (wt) body.apirone_webhook_token = wt;
      if (Object.keys(body).length === 0) { toast('No new credentials entered.', 'info'); setBusy(false); return; }
      const d = await post('/api/admin/settings', body);
      toast('Apirone credentials saved.', 'success');
      setApirone(d.apirone);
      setApiForm({ account_id: '', transfer_key: '', webhook_token: '' });
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusy(false); }
  };

  const testApirone = async () => {
    setTestBusy(true);
    try {
      const d = await post('/api/admin/settings/apirone/test');
      toast(d.ok ? 'Apirone connection OK — JWT token issued.' : 'Test failed.', d.ok ? 'success' : 'error');
    } catch (x) { toast(x.message, 'error'); } finally { setTestBusy(false); }
  };

  if (!s) return <div className="faint">Loading…</div>;

  const inrPerUsd = Number(s.exchange_rate || 100);
  const sim = mode === 'simulated';

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Finance, markup and payment knobs. Only you can see these.</p>
      <DepositMaintenanceCard />

      {/* Apirone section — credentials entered here are stored server-side
          (write-only, never returned by any API) and are required for real
          crypto payments. Without them, deposits run in simulated mode. */}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b style={{ color: 'var(--text)' }}>Apirone crypto payments</b>
          {sim
            ? <span className="badge badge-warn"><span className="dot" style={{ background: 'var(--warn)' }} /> Simulated mode</span>
            : <span className="badge badge-success"><span className="dot" style={{ background: 'var(--success)' }} /> Live Apirone</span>}
        </div>

        <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
          <div className="flex between"><span className="row-label">Endpoint</span><span className="mono faint">{apirone?.api_url_masked || 'configured'}</span></div>
          <div className="flex between"><span className="row-label">Account</span><span className="mono faint">{apirone?.account_masked || 'not set'}</span></div>
          <div className="flex between"><span className="row-label">Webhook</span>
            {apirone?.webhook_configured
              ? <span className="badge badge-success"><span className="dot" style={{ background: 'var(--success)' }} /> configured</span>
              : <span className="badge badge-danger">not configured</span>}
          </div>
        </div>
        <p className="faint" style={{ fontSize: '0.83rem', marginBottom: 12 }}>
          {sim
            ? <>No Account ID / Transfer Key set. Deposits are <b style={{ color: 'var(--warn)' }}>simulated</b> for offline
                testing — invoice creation never auto-credits the wallet. Enter real credentials below to go live.</>
            : <>Live mode active. The billing reconciler polls Apirone server-side every 20s, and every payment is
                verified against Apirone before the wallet is credited — partial payments credit only the verified amount.</>}
        </p>

        <label className="label">Account ID</label>
        <input className="input" placeholder={apirone?.account_masked ? `stored: ${apirone.account_masked} (blank = keep)` : 'not set'} value={apiForm.account_id} onChange={(e) => setApiForm({ ...apiForm, account_id: e.target.value })} autoComplete="off" />

        <label className="label">Transfer Key</label>
        <input className="input" type="password" placeholder="blank = keep current (never shown)" value={apiForm.transfer_key} onChange={(e) => setApiForm({ ...apiForm, transfer_key: e.target.value })} autoComplete="new-password" />

        <label className="label">Webhook Token <span className="faint">(optional, signs callbacks)</span></label>
        <input className="input" type="password" placeholder="blank = keep current" value={apiForm.webhook_token} onChange={(e) => setApiForm({ ...apiForm, webhook_token: e.target.value })} autoComplete="new-password" />

        <div className="flex" style={{ gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" onClick={saveApirone} disabled={busy}>{busy ? 'Saving…' : 'Save Apirone credentials'}</button>
          <button className="btn" onClick={testApirone} disabled={testBusy || !apirone?.configured}>
            {testBusy ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        <p className="faint" style={{ fontSize: '0.8rem', marginTop: 8 }}>
          Test connection authenticates against Apirone without creating any invoice. Credentials live only in the
          server database and never appear in the API.
        </p>
      </div>

      <form onSubmit={save} className="card" style={{ maxWidth: 560 }}>
        <label className="label">USD to INR exchange rate</label>
        <input className="input" type="number" min="1" value={s.exchange_rate} onChange={setNum('exchange_rate')} />
        <p className="faint" style={{ fontSize: '0.85rem', marginTop: 6 }}>
          Deposits are made in USD and credited in INR. Current: <b style={{ color: 'var(--text)' }}>1 USD = ₹{inrPerUsd.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b>
        </p>

        <label className="label">Deposit invoice timeout (hours)</label>
        <input className="input" type="number" min="1" value={s.deposit_timeout_hours} onChange={setNum('deposit_timeout_hours')} />
        <p className="faint" style={{ fontSize: '0.85rem', marginTop: 6 }}>Unpaid invoices expire after this window.</p>

        <div className="divider" />
        <b style={{ color: 'var(--text)' }}>Global markup (for new services)</b>
        <p className="faint" style={{ fontSize: '0.86rem', marginTop: 4 }}>
          Applied when a provider service is first synced and the provider itself has no markup.
          Existing per-service markups are never overwritten by a re-sync.
        </p>
        <div className="grid grid-2">
          <label className="label">Markup type</label>
          <label className="label">Value</label>
          <select className="select" value={String(s.global_markup_type || 'percent')} onChange={set('global_markup_type')}>
            <option value="percent">Percent (%)</option>
            <option value="fixed">Fixed (per 1k)</option>
          </select>
          <input className="input" type="number" min="0" step="any" value={s.global_markup_value ?? 25} onChange={setNum('global_markup_value')} />
        </div>

        <div className="divider" style={{ marginTop: 16 }} />
        <b style={{ color: 'var(--text)' }}>Payment simulator</b>
        <p className="faint" style={{ fontSize: '0.86rem', marginTop: 4 }}>
          Simulated invoices stay <b style={{ color: 'var(--warn)' }}>pending</b> until a payment event is
          explicitly triggered (Admin → Deposits → Verify → Confirm with a reason, or the simulator webhook).
          Auto-confirm should stay off — a created invoice is never a payment.</p>

        <label className="label">Auto-confirm simulated deposits (demo only — keep off)</label>
        <select className="select" value={String(s.demo_auto_confirm)} onChange={set('demo_auto_confirm')}>
          <option value="1">Enabled — auto-credit after a short delay (NOT for production)</option>
          <option value="0">Disabled — only explicit payment events confirm (recommended)</option>
        </select>

        {String(s.demo_auto_confirm) === '1' && (
          <>
            <label className="label">Confirm delay (seconds)</label>
            <input className="input" type="number" min="1" value={s.demo_confirm_seconds} onChange={setNum('demo_confirm_seconds')} />
          </>
        )}

        <div className="divider" style={{ marginTop: 16 }} />
        <b style={{ color: 'var(--text)' }}>Support channels</b>
        <p className="faint" style={{ fontSize: '0.86rem', marginTop: 4 }}>
          These belong to <b>InstaSMM</b> and are what clients see on the Support page.
          Leave a field blank to hide that channel; supplier contacts are never shown.
        </p>
        <div className="grid grid-2" style={{ marginTop: 4 }}>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" placeholder="support@instasmm.store" value={s.support_email || ''} onChange={set('support_email')} />
          </div>
          <div>
            <label className="label">WhatsApp</label>
            <input className="input" placeholder="+91 9XXXXXXXXX" value={s.support_whatsapp || ''} onChange={set('support_whatsapp')} />
          </div>
          <div>
            <label className="label">Telegram</label>
            <input className="input" placeholder="@instasmm" value={s.support_telegram || ''} onChange={set('support_telegram')} />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" type="tel" placeholder="+91 9XXXXXXXXX" value={s.support_phone || ''} onChange={set('support_phone')} />
          </div>
        </div>

        <button className="btn btn-primary" style={{ marginTop: 20 }} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </form>
    </>
  );
}