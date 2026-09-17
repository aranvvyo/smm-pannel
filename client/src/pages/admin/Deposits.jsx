import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr, fmtUsd, Empty, Icon, Modal } from '../../ui.jsx';

const CUR_DISPLAY = { LTC: 'LTC', BEP20_USDT: 'USDT (BEP20)', ERC20_USDT: 'USDT (ERC20)' };

const STATUS_BADGE = {
  pending: ['badge-warn', 'var(--warn)'],
  in_progress: ['badge-info', 'var(--info)'],
  confirmed: ['badge-success', 'var(--success)'],
  failed: ['badge-danger', 'var(--danger)'],
  expired: ['badge-muted', 'var(--faint)'],
  rejected: ['badge-danger', 'var(--danger)'],
};

export default function AdminDeposits() {
  const toast = useToast();
  const [deposits, setDeposits] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [verify, setVerify] = useState(null);       // deposit being verified
  const [reason, setReason] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => { setDeposits((await get('/api/admin/deposits')).deposits); setLoaded(true); };
  useEffect(() => { load(); }, []);

  // Fetch the full deposit detail (incl. upstream provider_event + confirmed_at)
  // into the verification modal — never confirm a deposit you can't inspect.
  const openVerify = async (d) => {
    setReason('');
    setDismissReason('');
    try {
      const detail = (await get(`/api/admin/deposits/${d.id}`)).deposit;
      setVerify(detail);
    } catch (x) { toast(x.message, 'error'); }
  };

  // Explicit confirm with an audit reason. Rejected if the deposit already
  // reached a terminal status, or if the operator gave no reason.
  const confirm = async () => {
    if (!verify) return;
    if (reason.trim().length < 3) { toast('A reason is required (audit trail).', 'error'); return; }
    setBusyId(verify.id);
    try {
      const r = await post(`/api/admin/deposits/${verify.id}/confirm`, { reason: reason.trim() });
      toast(`Confirmed — credited ${fmtInr(r.inr)}.`, 'success');
      setVerify(null);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusyId(null); }
  };

  // Dismiss (void) a deposit without recognising it as income. Only allowed for
  // non-terminal deposits that have NOT received any funds; the reason is mandatory.
  const dismiss = async () => {
    if (!verify) return;
    if (dismissReason.trim().length < 3) { toast('A reason is required (audit trail).', 'error'); return; }
    if (Number(verify.paid_usd || 0) > 0) { toast('Funds already received — cannot dismiss.', 'error'); return; }
    setBusyId(verify.id);
    try {
      await post(`/api/admin/deposits/${verify.id}/dismiss`, { reason: dismissReason.trim() });
      toast('Deposit dismissed.', 'success');
      setVerify(null);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusyId(null); }
  };

  const st = (s) => {
    const [cls, dot] = STATUS_BADGE[s] || ['badge-muted', 'var(--faint)'];
    return (
      <span className={`badge ${cls}`}>
        <span className="dot" style={{ background: dot }} />
        {s?.replace('_', ' ')}
      </span>
    );
  };

  return (
    <>
      <h1 className="page-title">Deposits</h1>
      <p className="page-sub">
        Crypto deposits. Credits happen exactly once per deposit, only after a valid payment
        event (real webhook / simulator) or an explicit, reason-audited manual confirm.
      </p>

      {loaded && deposits.length === 0 ? (
        <div className="card"><Empty icon="coins" text="No deposits yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Client</th><th>Amount (USD)</th><th>≈ INR credited</th><th>Coin</th>
                  <th>Address (masked)</th><th>Status</th><th>Created (IST)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((d) => (
                  <tr key={d.id}>
                    <td>{d.email}</td>
                    <td>{fmtUsd((d.amount_usd || 0) / 100)}</td>
                    <td>{fmtInr(d.amount_inr)}</td>
                    <td>
                      {CUR_DISPLAY[d.currency] || d.currency}
                      {d.is_simulated && (<span style={{ verticalAlign: 'middle', display: 'inline-flex', marginLeft: 6 }} title="Simulated deposit"><Icon name="settings" size={13} stroke={1.8} /></span>)}
                    </td>
                    <td className="mono faint" style={{ fontSize: '0.82rem' }}>
                      {d.address ? `${d.address.slice(0, 12)}…${d.address.slice(-6)}` : '—'}
                    </td>
                    <td>{st(d.status)}</td>
                    <td className="faint">{d.created_ist}</td>
                    <td>
                      {(d.status === 'pending' || d.status === 'in_progress') && (
                        <button className="btn btn-sm btn-outline" disabled={busyId === d.id}
                          onClick={() => openVerify(d)}>Verify</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {verify && (
        <Modal onClose={() => setVerify(null)} title={`Verify deposit #${verify.id}`}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="flex between"><span className="row-label">User</span><span className="row-value">{verify.email}</span></div>
            <div className="flex between"><span className="row-label">Amount</span>
              <span className="row-value">{fmtUsd((verify.amount_usd || 0) / 100)} ({CUR_DISPLAY[verify.currency] || verify.currency})</span></div>
            <div className="flex between"><span className="row-label">≈ INR credited</span><span className="row-value">{fmtInr(verify.amount_inr)}</span></div>
            <div className="flex between"><span className="row-label">Received (USD)</span>
              <span className="row-value">{fmtUsd((verify.paid_usd || 0) / 100)}</span></div>
            <div className="flex between"><span className="row-label">Status</span>{st(verify.status)}</div>
            <div className="flex between"><span className="row-label">Invoice</span><span className="mono faint">{verify.invoice_id}</span></div>
            <div className="flex between"><span className="row-label">Address</span>
              <span className="mono faint" style={{ maxWidth: '60%', textAlign: 'right', wordBreak: 'break-all' }}>{verify.address}</span></div>
            <div className="flex between"><span className="row-label">Simulated</span>
              <span className="row-value">{verify.is_simulated ? 'Yes (test)' : 'No'}</span></div>
            {verify.confirmed_at && (
              <div className="flex between"><span className="row-label">Confirmed at</span>
                <span className="row-value">{new Date(verify.confirmed_at).toLocaleString()}</span></div>
            )}
            {verify.provider_event && (
              <div className="flex between" style={{ alignItems: 'flex-start' }}>
                <span className="row-label">Upstream event</span>
                <span className="mono faint" style={{ maxWidth: '62%', textAlign: 'right', wordBreak: 'break-all', fontSize: '0.75rem' }}>{verify.provider_event}</span>
              </div>
            )}

            {['pending', 'in_progress'].includes(verify.status) ? (
              <div className="divider" />
            ) : (
              <div className="muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
                This deposit is <b>{verify.status}</b> — no further confirmation possible.
              </div>
            )}

            {['pending', 'in_progress'].includes(verify.status) && (
              <div className="stack" style={{ gap: 8 }}>
                <label className="label">Reason for manual confirmation</label>
                <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Payment seen on the blockchain explorer; user contacted support…" />
                <p className="faint" style={{ fontSize: '0.8rem' }}>
                  Required — recorded in the security audit log with your account. A reason-less blind
                  confirm is rejected. Creating an invoice never auto-credits.
                </p>
                <button className="btn btn-success" onClick={confirm} disabled={busyId === verify.id}>
                  {busyId === verify.id ? 'Confirming…' : 'Confirm & credit wallet'}
                </button>
              </div>
            )}

            {['pending', 'in_progress'].includes(verify.status) && (
              <div className="divider" style={{ marginTop: 14 }} />
            )}

            {['pending', 'in_progress'].includes(verify.status) && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="flex between">
                  <label className="label" style={{ margin: 0 }}>Dismiss / reject invoice</label>
                  <span className="faint" style={{ fontSize: '0.75rem' }}>only when <b>no funds</b> were received</span>
                </div>
                <textarea className="input" rows={2} value={dismissReason} onChange={(e) => setDismissReason(e.target.value)}
                  placeholder="Why is this invoice void? e.g. user requested cancel; wrong invoice…" />
                <button className="btn btn-danger btn-sm" onClick={dismiss} disabled={busyId === verify.id || Number(verify.paid_usd || 0) > 0}>
                  Dismiss invoice
                </button>
                {Number(verify.paid_usd || 0) > 0 && (
                  <p className="faint" style={{ fontSize: '0.8rem' }}>
                    Funds were already received — this invoice can only be confirmed, never dismissed.
                  </p>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}