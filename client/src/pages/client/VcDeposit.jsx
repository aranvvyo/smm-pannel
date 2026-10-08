import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast, fmtInr, Icon, timeAgo } from '../../ui.jsx';
import {
  SURCHARGE_BPS, MAX_RUPEES, inrCreditPaise, inrSurchargePaise, inrTotalPaise,
} from '../../lib/inrPayments.js';

// ---------------------------------------------------------------------------
// VCGetaway INR deposit — MANUAL VERIFICATION WORKFLOW.
//
// The VCGetaway gateway publishes no merchant API contract, so there is
// NO automated checkout: this page talks only to OUR backend
// (/api/deposits/inr). The flow is:
//   1. Request a deposit  → a PENDING record (credit / 10% customer
//      surcharge / total) — nothing is credited, nothing is paid.
//   2. The customer pays the operator-issued UPI invoice (out of
//      band) and presses "I Have Paid" — which RECORDS A CLAIM ONLY.
//      A claim is never proof of payment and never credits a wallet.
//   3. An authorized admin verifies the ACTUAL payment server-side
//      (Admin → Deposits → INR) — only then is the wallet credited,
//      exactly once, with the CREDIT amount (never the total).
//
// GATEWAY_CONNECTED gates the (future) automated gateway flow. It
// stays FALSE: no VCGetaway endpoint is called, no payment is
// initiated, and no client-side flag can credit a wallet.
// ---------------------------------------------------------------------------

// Flip to true ONLY once the server exposes a verified VCGetaway
// checkout endpoint. Until then the automated flow stays disconnected
// and the manual workflow above is the only path.
const GATEWAY_CONNECTED = false;

// Quick-pick amounts, in rupees (the panel stores money as integer paise).
const PRESETS = [500, 1000, 2500, 5000, 10000];

const INR_STATUS = {
  pending: ['badge-warn', 'var(--warn)', 'Awaiting payment'],
  awaiting_verification: ['badge-info', 'var(--info)', 'Awaiting verification'],
  verified: ['badge-success', 'var(--success)', 'Verified — credited'],
  denied: ['badge-danger', 'var(--danger)', 'Not verified'],
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export default function VcDeposit() {
  const toast = useToast();
  const reduced = useReducedMotion();
  const [rupees, setRupees] = useState('');
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const cardRef = useRef(null);

  // Workflow state. `active` is the deposit record currently shown;
  // `hist` is the client's own request history. Server truth only —
  // the UI never invents, caches, or derives a credit itself.
  const [active, setActive] = useState(null);
  const [hist, setHist] = useState([]);
  const [busy, setBusy] = useState(false);          // creating a request
  const [claimBusy, setClaimBusy] = useState(false); // recording a claim
  const [err, setErr] = useState('');

  // Money math — all integer paise, from the shared INR helpers (the
  // single source of truth). The customer picks how much wallet CREDIT
  // they want; a transparent 10% customer surcharge is added on top to
  // reach the final payable. The wallet is credited the CREDIT amount
  // only — never the total.
  const creditPaise = useMemo(() => inrCreditPaise(rupees) || 0, [rupees]);
  const surchargePaise = inrSurchargePaise(creditPaise);
  const finalPaise = inrTotalPaise(creditPaise);
  const valid = creditPaise > 0;

  const load = async () => {
    const d = await get('/api/deposits/inr');
    setHist(d.deposits);
    return d.deposits;
  };

  // Load history; reopen the most recent non-terminal request (the
  // same pattern the crypto deposit page uses for pending invoices).
  useEffect(() => {
    (async () => {
      try {
        const deposits = await load();
        const open = deposits.find((d) => ['pending', 'awaiting_verification'].includes(d.status));
        if (open) setActive(open);
      } catch (x) { setErr(x.message); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a non-terminal request is open, poll the server — an admin
  // may verify (or deny) the payment while the customer is here.
  useEffect(() => {
    if (!active || !['pending', 'awaiting_verification'].includes(active.status)) return undefined;
    const id = setInterval(async () => {
      try {
        const d = await get(`/api/deposits/inr/${active.id}`);
        setActive(d.deposit);
        setHist((h) => h.map((x) => (x.id === d.deposit.id ? d.deposit : x)));
      } catch { /* transient — retry next tick */ }
    }, 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.status]);

  // Step 1 — request a deposit. Creates a PENDING record only: no
  // invoice/QR/UPI data is fabricated, nothing is credited.
  const create = async (e) => {
    e.preventDefault();
    if (!valid) { setErr(`Enter a valid amount in ₹ (max ${fmtInr(MAX_RUPEES * 100)}).`); return; }
    setErr(''); setBusy(true);
    try {
      const d = await post('/api/deposits/inr', { rupees: Number(rupees) });
      setActive(d.deposit);
      setHist((h) => [d.deposit, ...h.filter((x) => x.id !== d.deposit.id)]);
      setRupees('');
      toast(`Deposit requested — pay ${fmtInr(d.deposit.total_paise)} (includes ${fmtInr(d.deposit.surcharge_paise)} customer surcharge).`, 'success');
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  // Step 2 — "I Have Paid". RECORDS A CLAIM ONLY: it transitions the
  // record to awaiting_verification and nothing else. It is never
  // treated as proof of payment and never credits the wallet — only an
  // admin verification of the actual payment can do that.
  const claim = async () => {
    if (!active) return;
    setErr('');
    setClaimBusy(true);
    try {
      const d = await post(`/api/deposits/inr/${active.id}/claim`);
      setActive(d.deposit);
      setHist((h) => h.map((x) => (x.id === d.deposit.id ? d.deposit : x)));
      toast('Claim recorded — awaiting admin verification. Your wallet is credited only after verification.', 'success');
    } catch (x) { setErr(x.message); } finally { setClaimBusy(false); }
  };

  // Future automated flow — unreachable while GATEWAY_CONNECTED is false.
  const pay = () => {
    if (!GATEWAY_CONNECTED || !valid) return;
  };

  // Subtle pointer-driven 3D tilt (CSS transform only). Off under
  // reduced-motion and on touch devices (no hover surface).
  const onMove = (e) => {
    if (reduced || !cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: px * 9, y: -py * 9 });
  };
  const onLeave = () => { setTilt({ x: 0, y: 0 }); };
  const pickPreset = (v) => { setRupees(String(v)); };

  // What the summary shows: a valid typed amount previews
  // immediately; the open deposit (or a history selection)
  // shows when nothing is entered.
  const showCredit = valid ? creditPaise : (active ? Number(active.credit_paise) : 0);
  const showSurcharge = valid ? surchargePaise : (active ? Number(active.surcharge_paise) : 0);
  const showTotal = valid ? finalPaise : (active ? Number(active.total_paise) : 0);
  const showAny = !!active || valid;

  const st = (s) => {
    const [cls, dot, label] = INR_STATUS[s] || ['badge-muted', 'var(--faint)', s || '—'];
    return (
      <span className={`badge ${cls}`}>
        <span className="dot" style={{ background: dot }} />
        {label}
      </span>
    );
  };

  return (
    <>
      <h1 className="page-title">Deposit in INR</h1>
      <p className="page-sub">
        Add funds via VCGetaway — card, UPI &amp; net banking. Payments are verified
        manually: your wallet is credited only after an authorized admin confirms
        the payment, and only with the credit amount you requested.
      </p>

      <div className="vc-grid">
        {/* Left — display-only 3D payment card preview + amount picker */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="vc-scene">
            <div
              ref={cardRef}
              className="vc-card3d"
              style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
              onMouseMove={onMove}
              onMouseLeave={onLeave}
              role="img"
              aria-label="VCGetaway payment card preview"
            >
              <div className="vc-card3d-face">
                <div className="vc-shine" />
                <div className="vc-brand">
                  <span className="vc-mark"><Icon name="coins" size={17} stroke={2} /></span>
                  <span>VCGetaway</span>
                  {!GATEWAY_CONNECTED && <span className="vc-surcharge-badge" style={{ marginLeft: 'auto' }}>Preview</span>}
                </div>
                <div>
                  <div className="vc-amount">{showAny ? fmtInr(showTotal) : '₹ —'}</div>
                  <div className="vc-amount-sub">
                    {showAny ? `total payable · includes ${(SURCHARGE_BPS / 100).toFixed(0)}% customer surcharge` : 'enter an amount to preview'}
                  </div>
                </div>
                <div className="vc-foot">
                  <span className="vc-chip" />
                  <span className="vc-network">INR · UPI / Card / NetBanking</span>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <form onSubmit={create}>
              <div className="card-label">Select amount</div>
              <div className="vc-presets" style={{ marginTop: 12 }}>
                {PRESETS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`vc-preset ${Number(rupees) === v ? 'active' : ''}`}
                    onClick={() => pickPreset(v)}
                  >
                    ₹{v.toLocaleString('en-IN')}
                  </button>
                ))}
              </div>
              <label className="label" htmlFor="vc-amount">Custom amount (₹)</label>
              <input
                id="vc-amount"
                className="input"
                type="number"
                inputMode="decimal"
                min="1"
                step="1"
                placeholder="0"
                value={rupees}
                onChange={(e) => setRupees(e.target.value)}
              />
              <p className="faint" style={{ fontSize: '0.82rem', marginTop: 8 }}>
                No minimum — enter any amount up to {fmtInr(MAX_RUPEES * 100)}. A 10% customer surcharge is added to the total you pay.
              </p>
              {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}
              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} disabled={busy || !valid}>
                {busy ? 'Requesting…' : 'Request deposit'}
              </button>
              <p className="faint" style={{ fontSize: '0.78rem', marginTop: 8, lineHeight: 1.5 }}>
                After requesting, you will be asked to pay the total via the UPI invoice
                issued by the operator — the wallet receives the credit amount, never the total.
              </p>
            </form>
          </div>
        </div>

        {/* Right — breakdown + open deposit + history */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-label">Payment summary</div>
            <div className="vc-rows" style={{ marginTop: 10 }}>
              <div className="vc-row">
                <span className="vc-k"><Icon name="wallet" size={15} /> Wallet credit</span>
                <span className="vc-v">{showAny ? fmtInr(showCredit) : '—'}</span>
              </div>
              <div className="vc-row">
                <span className="vc-k">
                  <Icon name="percent" size={15} />
                  Customer surcharge
                  <span className="vc-surcharge-badge">10%</span>
                </span>
                <span className="vc-v">{showAny ? fmtInr(showSurcharge) : '—'}</span>
              </div>
            </div>
            <div className="vc-total vc-row">
              <span className="vc-k" style={{ color: 'var(--text)', fontWeight: 800 }}>Total payable</span>
              <span className="vc-v">{showAny ? fmtInr(showTotal) : '—'}</span>
            </div>
            <p className="faint" style={{ fontSize: '0.8rem', marginTop: 10, lineHeight: 1.5 }}>
              The customer surcharge covers payment processing and is shown up front —
              the amount credited to your wallet is exactly the credit figure above.
            </p>
          </div>

          {active && (
            <div className="card">
              <div className="flex between">
                <div className="card-label">Deposit #{active.id}</div>
                {st(active.status)}
              </div>

              {active.invoice_ref && (
                <div className="vc-row" style={{ marginTop: 8 }}>
                  <span className="vc-k"><Icon name="qr" size={15} /> Invoice reference</span>
                  <span className="vc-v mono">{active.invoice_ref}</span>
                </div>
              )}

              {active.status === 'pending' && (
                <>
                  <div className="vc-status pending" role="status" aria-live="polite">
                    <span className="dot pulse" style={{ background: 'var(--warn)' }} />
                    <span>
                      Pay <b>{fmtInr(Number(active.total_paise))}</b> via the UPI invoice issued by the operator
                      {active.invoice_ref
                        ? <> — include the invoice reference <b>{active.invoice_ref}</b> in the payment remarks</>
                        : ' (contact support if you have not received one)'}.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    style={{ width: '100%', marginTop: 14 }}
                    onClick={claim}
                    disabled={claimBusy}
                  >
                    <Icon name="check" size={16} stroke={2} />
                    {claimBusy ? 'Recording…' : 'I Have Paid'}
                  </button>
                  <p className="faint" style={{ fontSize: '0.78rem', marginTop: 6, lineHeight: 1.5 }}>
                    "I Have Paid" only records your claim — it never verifies or credits anything.
                    An authorized admin must verify the actual payment before your wallet is credited.
                  </p>
                </>
              )}

              {active.status === 'awaiting_verification' && (
                <div className="vc-status pending" role="status" aria-live="polite">
                  <span className="dot pulse" style={{ background: 'var(--warn)' }} />
                  <span>
                    Claim recorded — awaiting verification. Your wallet is credited only after an
                    authorized admin verifies the payment. This can take a few minutes.
                  </span>
                </div>
              )}

              {active.status === 'verified' && (
                <div className="vc-status success" role="status">
                  <span className="dot" style={{ background: 'var(--success)' }} />
                  <span>
                    Payment verified — <b>{fmtInr(Number(active.credit_paise))}</b> has been credited to
                    your wallet (you paid {fmtInr(Number(active.total_paise))} including the customer surcharge).
                  </span>
                </div>
              )}

              {active.status === 'denied' && (
                <div className="vc-status failed" role="alert">
                  <span className="dot" style={{ background: 'var(--danger)' }} />
                  <span>
                    Payment not verified — no amount was credited. Contact support, or request a new
                    deposit with the form on the left.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="card">
            <div className="card-label">Deposit history</div>
            {hist.length === 0 ? (
              <div className="empty" style={{ padding: '22px 10px' }}>
                <div className="empty-icon"><Icon name="coins" size={26} stroke={1.4} /></div>
                <div className="empty-text">No INR deposits yet</div>
                <div className="empty-sub">Completed requests will appear here.</div>
              </div>
            ) : (
              <div className="vc-tx-list" style={{ marginTop: 12 }}>
                {hist.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="vc-tx"
                    style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => setActive(d)}
                  >
                    <span className="vc-tx-icon" style={{ color: 'var(--accent-2)' }}>
                      <Icon name="bank" size={18} stroke={1.7} />
                    </span>
                    <span className="vc-tx-main">
                      <span className="vc-tx-amount">{fmtInr(Number(d.total_paise))}</span>
                      <span className="vc-tx-meta" style={{ display: 'block' }}>
                        credit {fmtInr(Number(d.credit_paise))} · {timeAgo(d.created_at)}
                      </span>
                    </span>
                    {st(d.status)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
