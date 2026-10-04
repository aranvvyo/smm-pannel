import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtInr, Icon } from '../../ui.jsx';

// ---------------------------------------------------------------------------
// VCGetaway INR deposit — DESIGN SCAFFOLD ONLY.
//
// The VCGetaway gateway (https://www.vcgetaway.site/) publishes NO verifiable
// API contract (no checkout-creation endpoint, auth scheme, webhook
// signature spec, transaction-status endpoint or minimum amount). Until the
// official documentation is obtained and a server-side checkout + verification
// flow is built, this page:
//   • performs NO network calls (there is no endpoint to call),
//   • NEVER initiates a payment or simulates a success,
//   • NEVER credits a wallet from a client-side flag,
//   • keeps the pay action disabled behind GATEWAY_CONNECTED.
//
// The full experience (amount picker, transparent 10% CUSTOMER SURCHARGE
// breakdown, 3D card, pending/success/failed state machine, transaction
// cards) is implemented and ready — flipping GATEWAY_CONNECTED to true and
// wiring the (future) API calls is the only remaining step.
// ---------------------------------------------------------------------------

// Flip to true ONLY once the server exposes a verified VCGetaway checkout
// endpoint. Until then the flow stays in the "not connected" state.
const GATEWAY_CONNECTED = false;

// 10% customer surcharge, expressed in basis points (1000 bp = 10%).
// Labeled "customer surcharge" everywhere — never a "gateway fee".
const SURCHARGE_BPS = 1000;

// Quick-pick amounts, in rupees (the panel stores money as integer paise).
const PRESETS = [500, 1000, 2500, 5000, 10000];

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
  const reduced = useReducedMotion();
  const [rupees, setRupees] = useState('');
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const cardRef = useRef(null);

  // State machine — implemented and ready, but only reachable once the
  // backend creates a real checkout session. With GATEWAY_CONNECTED=false
  // it stays in 'idle' and the pay action is disabled, so no pending /
  // success / failed state is ever faked.
  const [phase, setPhase] = useState('idle'); // idle | pending | success | failed
  const [txs, setTxs] = useState([]); // real transactions once connected

  // Money math — all integer paise. The customer picks how much wallet
  // CREDIT they want; a transparent 10% customer surcharge is added on
  // top to reach the final payable.
  const creditPaise = useMemo(() => {
    const n = Number(rupees);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  }, [rupees]);
  const surchargePaise = Math.round((creditPaise * SURCHARGE_BPS) / 10000);
  const finalPaise = creditPaise + surchargePaise;
  const valid = creditPaise > 0;

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
  const onLeave = () => setTilt({ x: 0, y: 0 });

  const pickPreset = (v) => {
    setRupees(String(v));
  };

  // Future: POST /api/deposits/vcgetaway { credit_paise } → session,
  // then poll a status endpoint and trust ONLY the server-verified
  // result. Intentionally NOT implemented until the API contract is
  // verified — with GATEWAY_CONNECTED=false this is unreachable.
  const pay = () => {
    if (!GATEWAY_CONNECTED || !valid) return;
  };

  const tiltStyle = {
    transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
  };

  return (
    <>
      <h1 className="page-title">Deposit in INR</h1>
      <p className="page-sub">
        Add funds to your wallet via VCGetaway — card, UPI & net banking.
      </p>

      <div className="vc-grid">
        {/* Left — 3D payment card + amount picker */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="vc-scene">
            <div
              ref={cardRef}
              className="vc-card3d"
              style={tiltStyle}
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
                  <div className="vc-amount">{valid ? fmtInr(finalPaise) : '₹ —'}</div>
                  <div className="vc-amount-sub">
                    {valid ? `total payable · includes ${(SURCHARGE_BPS / 100).toFixed(0)}% customer surcharge` : 'enter an amount to preview'}
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
              No minimum — enter any amount. A 10% customer surcharge is added to the total you pay.
            </p>
          </div>
        </div>

        {/* Right — breakdown + pay + status + transactions */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-label">Payment summary</div>
            <div className="vc-rows" style={{ marginTop: 10 }}>
              <div className="vc-row">
                <span className="vc-k"><Icon name="wallet" size={15} /> Wallet credit</span>
                <span className="vc-v">{valid ? fmtInr(creditPaise) : '—'}</span>
              </div>
              <div className="vc-row">
                <span className="vc-k">
                  <Icon name="percent" size={15} />
                  Customer surcharge
                  <span className="vc-surcharge-badge">10%</span>
                </span>
                <span className="vc-v">{valid ? fmtInr(surchargePaise) : '—'}</span>
              </div>
            </div>
            <div className="vc-total vc-row">
              <span className="vc-k" style={{ color: 'var(--text)', fontWeight: 800 }}>Total payable</span>
              <span className="vc-v">{valid ? fmtInr(finalPaise) : '—'}</span>
            </div>
            <p className="faint" style={{ fontSize: '0.8rem', marginTop: 10, lineHeight: 1.5 }}>
              The customer surcharge covers payment processing and is shown up front —
              the amount credited to your wallet is exactly the figure above.
            </p>

            {!GATEWAY_CONNECTED && (
              <div className="vc-notice" role="status">
                <span className="vc-notice-icon"><Icon name="alert" size={16} /></span>
                <span>
                  <b>VCGetaway integration is pending.</b> This payment method is not
                  connected yet — no payment can be initiated and no funds are moved.
                  The full experience is staged here and will go live once the gateway
                  is verified and wired up server-side.
                </span>
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary btn-lg"
              style={{ width: '100%', marginTop: 16 }}
              disabled={!GATEWAY_CONNECTED || !valid}
              onClick={pay}
            >
              <Icon name="lock" size={16} stroke={2} />
              {GATEWAY_CONNECTED ? 'Continue to VCGetaway' : 'VCGetaway — integration pending'}
            </button>

            {/* State machine — only rendered for a real session. */}
            {phase === 'pending' && (
              <div className="vc-status pending" role="status" aria-live="polite">
                <span className="dot pulse" style={{ background: 'var(--warn)' }} />
                Waiting for payment… your wallet is credited the moment VCGetaway confirms the transaction.
              </div>
            )}
            {phase === 'success' && (
              <div className="vc-status success" role="status">
                <span className="dot" style={{ background: 'var(--success)' }} />
                Payment confirmed — your wallet has been credited.
              </div>
            )}
            {phase === 'failed' && (
              <div className="vc-status failed" role="alert">
                <span className="dot" style={{ background: 'var(--danger)' }} />
                Payment failed. No money was moved — please try again or choose another method.
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-label">Transactions</div>
            {txs.length === 0 ? (
              <div className="empty" style={{ padding: '26px 10px' }}>
                <div className="empty-icon"><Icon name="coins" size={26} stroke={1.4} /></div>
                <div className="empty-text">No VCGetaway transactions yet</div>
                <div className="empty-sub">Completed deposits will appear here.</div>
              </div>
            ) : (
              <div className="vc-tx-list" style={{ marginTop: 12 }}>
                {txs.map((tx) => (
                  <div key={tx.id} className="vc-tx">
                    <span className="vc-tx-icon" style={{ color: 'var(--accent-2)' }}>
                      <Icon name="bank" size={18} stroke={1.7} />
                    </span>
                    <span className="vc-tx-main">
                      <span className="vc-tx-amount">{fmtInr(tx.amountInr)}</span>
                      <span className="vc-tx-meta" style={{ display: 'block' }}>{tx.ref}</span>
                    </span>
                    <span className={`badge ${tx.status === 'success' ? 'badge-success' : tx.status === 'pending' ? 'badge-warn' : 'badge-danger'}`}>
                      <span className="dot" style={{ background: tx.status === 'success' ? 'var(--success)' : tx.status === 'pending' ? 'var(--warn)' : 'var(--danger)' }} />
                      {tx.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
