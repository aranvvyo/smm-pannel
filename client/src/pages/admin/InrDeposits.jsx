import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr, Empty, Icon, Modal } from '../../ui.jsx';

const INR_STATUS = {
  pending: ['badge-warn', 'var(--warn)', 'Awaiting payment'],
  awaiting_verification: ['badge-info', 'var(--info)', 'Awaiting verification'],
  verified: ['badge-success', 'var(--success)', 'Verified'],
  denied: ['badge-danger', 'var(--danger)', 'Not verified'],
};

// Admin INR deposits — the MANUAL verification half of the VCGetaway
// workflow. Every credit requires an explicit, reason-audited verify;
// the wallet is credited the CREDIT amount (never the surcharge-
// inclusive total), exactly once, atomically — all enforced server-side.
export default function InrDeposits() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [verify, setVerify] = useState(null);   // deposit being verified/denied
  const [error, setError] = useState('');       // list load failure
  const [reason, setReason] = useState('');
  const [denyReason, setDenyReason] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setError('');
    try {
      const d = await get('/api/admin/deposits/inr');
      setRows(d.deposits);
    } catch (x) { setError(x.message); }
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  // Fetch the full detail into the modal — never verify a deposit
  // you can't inspect.
  const openVerify = async (d) => {
    setReason('');
    setDenyReason('');
    setPaymentRef('');
    setInvoiceRef('');
    try {
      const detail = (await get(`/api/admin/deposits/inr/${d.id}`)).deposit;
      setVerify(detail);
    } catch (x) { toast(x.message, 'error'); }
  };

  // Manual verification of the ACTUAL payment. The reason is mandatory
  // and recorded in the security audit log; the server credits the
  // wallet the CREDIT amount exactly once.
  const verifyDeposit = async () => {
    if (!verify) return;
    if (reason.trim().length < 3) { toast('A reason is required (audit trail).', 'error'); return; }
    if (!paymentRef.trim()) { toast('Enter the bank or UPI payment reference before verifying.', 'error'); return; }
    setBusyId(verify.id);
    try {
      const r = await post(`/api/admin/deposits/inr/${verify.id}/verify`, {
        reason: reason.trim(),
        payment_ref: paymentRef.trim(),
        invoice_ref: invoiceRef.trim() || undefined,
      });
      toast(`Verified — credited ${fmtInr(r.inr)}.`, 'success');
      setVerify(null);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusyId(null); }
  };

  // Deny — verification failed (payment not received / not matched).
  // No credit, ever. The reason is mandatory and audit-logged.
  const denyDeposit = async () => {
    if (!verify) return;
    if (denyReason.trim().length < 3) { toast('A reason is required (audit trail).', 'error'); return; }
    setBusyId(verify.id);
    try {
      await post(`/api/admin/deposits/inr/${verify.id}/deny`, { reason: denyReason.trim() });
      toast('Deposit denied — no amount credited.', 'success');
      setVerify(null);
      load();
    } catch (x) { toast(x.message, 'error'); } finally { setBusyId(null); }
  };

  const st = (s) => {
    const [cls, dot, label] = INR_STATUS[s] || ['badge-muted', 'var(--faint)', s || '—'];
    return (
      <span className={`badge ${cls}`}>
        <span className="dot" style={{ background: dot }} />
        {label}
      </span>
    );
  };

  const open = verify && ['pending', 'awaiting_verification'].includes(verify.status);

  return (
    <>
      <div className="flex between" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {loaded && !error
            ? `${rows.length} INR deposit request${rows.length === 1 ? '' : 's'}`
            : 'INR deposit requests'}
        </span>
        <button type="button" className="btn btn-outline btn-sm" onClick={load}>Refresh</button>
      </div>

      {error ? (
        <div className="card">
          <div className="field-error"><Icon name="alert" size={15} /> {error}</div>
          <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={load}>Retry</button>
        </div>
      ) : loaded && rows.length === 0 ? (
        <div className="card"><Empty icon="bank" text="No INR deposits yet." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Client</th><th>Wallet credit</th><th>Surcharge (10%)</th><th>Total paid</th>
                  <th>Status</th><th>Created (IST)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>{d.email}</td>
                    <td style={{ color: 'var(--success)', fontWeight: 700 }}>{fmtInr(d.credit_paise)}</td>
                    <td>{fmtInr(d.surcharge_paise)}</td>
                    <td>{fmtInr(d.total_paise)}</td>
                    <td>{st(d.status)}</td>
                    <td className="faint">{d.created_ist}</td>
                    <td>
                      {['pending', 'awaiting_verification'].includes(d.status) && (
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
        <Modal onClose={() => setVerify(null)} title={`INR deposit #${verify.id}`}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="flex between"><span className="row-label">User</span><span className="row-value">{verify.user_name || verify.email}</span></div>
            <div className="flex between"><span className="row-label">Email</span><span className="row-value faint">{verify.email}</span></div>
            <div className="flex between"><span className="row-label">Wallet credit</span>
              <span className="row-value" style={{ color: 'var(--success)' }}>{fmtInr(verify.credit_paise)}</span></div>
            <div className="flex between"><span className="row-label">Customer surcharge (10%)</span><span className="row-value">{fmtInr(verify.surcharge_paise)}</span></div>
            <div className="flex between"><span className="row-label">Total paid</span><span className="row-value">{fmtInr(verify.total_paise)}</span></div>
            <div className="flex between"><span className="row-label">Status</span>{st(verify.status)}</div>
            <div className="flex between"><span className="row-label">Created</span><span className="row-value">{verify.created_ist}</span></div>
            {verify.invoice_ref && (
              <div className="flex between"><span className="row-label">Invoice ref</span><span className="mono faint">{verify.invoice_ref}</span></div>
            )}
            {verify.payment_ref && (
              <div className="flex between"><span className="row-label">Payment ref</span><span className="mono faint">{verify.payment_ref}</span></div>
            )}

            {verify.status === 'verified' && (
              <>
                <div className="flex between"><span className="row-label">Verified at</span>
                  <span className="row-value">{new Date(verify.verified_at).toLocaleString()}</span></div>
                {verify.verify_note && (
                  <div className="flex between" style={{ alignItems: 'flex-start' }}>
                    <span className="row-label">Audit note</span>
                    <span className="faint" style={{ maxWidth: '60%', textAlign: 'right', fontSize: '0.8rem' }}>{verify.verify_note}</span>
                  </div>
                )}
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  Wallet credited <b>{fmtInr(verify.credit_paise)}</b> exactly once. A verified
                  deposit can never be credited or denied again.
                </div>
              </>
            )}

            {verify.status === 'denied' && (
              <>
                {verify.verify_note && (
                  <div className="flex between" style={{ alignItems: 'flex-start' }}>
                    <span className="row-label">Deny reason</span>
                    <span className="faint" style={{ maxWidth: '60%', textAlign: 'right', fontSize: '0.8rem' }}>{verify.verify_note}</span>
                  </div>
                )}
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  No amount was credited. A denied deposit can never be verified.
                </div>
              </>
            )}

            {open && (
              <>
                <div className="divider" />
                <div className="stack" style={{ gap: 8 }}>
                  <label className="label">Reason for verification (required — audit trail)</label>
                  <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. UPI payment received and matched against the issued invoice; payment ref …" />
                  <label className="label">Payment reference (required — one payment can verify one deposit only)</label>
                  <input className="input" value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)}
                    placeholder="UPI / transaction reference" />
                  <label className="label">Invoice reference (optional)</label>
                  <input className="input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)}
                    placeholder="VCGetaway invoice reference" />
                  <p className="faint" style={{ fontSize: '0.8rem' }}>
                    Required — recorded in the security audit log with your account. The wallet is credited the
                    <b> credit amount ({fmtInr(verify.credit_paise)})</b> — never the surcharge-inclusive total —
                    exactly once.
                  </p>
                  <button className="btn btn-success" onClick={verifyDeposit} disabled={busyId === verify.id}>
                    {busyId === verify.id ? 'Verifying…' : 'Verify & credit wallet'}
                  </button>
                </div>

                <div className="divider" style={{ marginTop: 14 }} />

                <div className="stack" style={{ gap: 8 }}>
                  <div className="flex between">
                    <label className="label" style={{ margin: 0 }}>Deny deposit</label>
                    <span className="faint" style={{ fontSize: '0.75rem' }}>only when the payment was <b>not</b> received</span>
                  </div>
                  <textarea className="input" rows={2} value={denyReason} onChange={(e) => setDenyReason(e.target.value)}
                    placeholder="Why is this deposit rejected? e.g. no matching UPI payment found…" />
                  <button className="btn btn-danger btn-sm" onClick={denyDeposit} disabled={busyId === verify.id}>
                    Deny deposit — no credit
                  </button>
                </div>
              </>
            )}

            {!open && (
              <div className="muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
                This deposit is <b>{verify.status}</b> — no further action possible.
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
