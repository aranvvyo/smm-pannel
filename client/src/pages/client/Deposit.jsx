import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api.js';
import { useToast, fmtInr, fmtUsd, fmtRateINR, timeAgo, Icon } from '../../ui.jsx';
import QRCode from 'qrcode';
import { useDepositMaintenance, isDepositMaintenanceError } from '../../lib/depositMaintenance.js';
import DepositMaintenanceBanner from '../../lib/DepositMaintenanceBanner.jsx';

const CUR = {
  LTC: { label: 'Litecoin', short: 'LTC', chain: 'Litecoin network', fmt: 'LTC', decimals: 8, code: 'ltc' },
  BEP20_USDT: { label: 'USDT (BEP20)', short: 'USDT', chain: 'BNB Smart Chain (BEP20)', fmt: 'USDT', decimals: 6, code: 'usdt@bnb' },
  ERC20_USDT: { label: 'USDT (ERC20)', short: 'USDT', chain: 'Ethereum (ERC20)', fmt: 'USDT', decimals: 6, code: 'usdt@eth' },
};

// Real crypto display: amount_minor is an integer of the currency's own
// decimals (e.g. 5_000_000 LTC satoshi = "0.05 LTC"). Never rendered as USD.
// Returns '' for a missing amount so callers can fall back to the USD figure —
// "0" is truthy and would silently defeat that fallback.
const fmtCrypto = (currency, minor) => {
  if (minor == null) return '';
  const dec = CUR[currency]?.decimals ?? 8;
  const n = (Number(minor) || 0) / Math.pow(10, dec);
  return n.toLocaleString('en-US', { maximumFractionDigits: dec });
};

function clockTil(ms) {
  if (!ms || ms < Date.now()) return 'expired';
  const s = Math.floor((ms - Date.now()) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m left`;
}

export default function Deposit() {
  const toast = useToast();
  const [cryptos, setCryptos] = useState([]);
  const [sim, setSim] = useState(false);
  const [rate, setRate] = useState(100);
  const [currency, setCurrency] = useState('LTC');
  const [amountUsd, setAmountUsd] = useState('');
  const [invoice, setInvoice] = useState(null);   // reopens the SAME invoice
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [hist, setHist] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [copyState, setCopyState] = useState(null); // 'ok' | 'err' | null
  const [qrDataUrl, setQrDataUrl] = useState('');
  // Maintenance switch for crypto. Blocks only creating a new invoice; open
  // invoices, their QR and history stay available.
  const maint = useDepositMaintenance();
  const cryptoOff = maint.crypto.maintenance;

  const refresh = async () => {
    const [c, h] = await Promise.all([get('/api/cryptos'), get('/api/deposits')]);
    setCryptos(c.cryptos); setSim(c.simulated);
    setRate(h.exchange_rate);
    setHist(h.deposits);
  };

  // Auto-reopen the most recent still-pending invoice after a page load, so the
  // address doesn't get lost. Confirmed rows are re-openable from history.
  const load = async () => {
    const h = await get('/api/deposits');
    setRate(h.exchange_rate);
    setHist(h.deposits);
    if (!invoice) {
      const pending = h.deposits.find((d) => d.status === 'pending');
      if (pending) openInvoice(pending.id);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Clicking a history row reopens the SAME deposit invoice from the server
  // (address/QR/network/amount/status/expiry) — never creates a new one (Task 2).
  const openInvoice = async (id) => {
    try {
      const d = await get(`/api/deposits/${id}`);
      setInvoice(d.deposit);
      setErr('');
    } catch (x) {
      setErr(x.message);
    }
  };

  // Live countdown + auto-refresh while an invoice is awaiting payment.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (invoice && ['pending', 'in_progress'].includes(invoice.status)) {
      const id = setInterval(refresh, 8000);
      return () => clearInterval(id);
    }
  }, [invoice?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // QR payload — the REAL crypto amount derived from amount_minor, never the
  // USD figure. Standard: litecoin: for LTC; plain address for EVM tokens.
  useEffect(() => {
    if (invoice?.address && ['pending', 'in_progress'].includes(invoice.status)) {
      const coin = fmtCrypto(invoice.currency, invoice.amount_minor);
      const payload = invoice.currency === 'LTC'
        ? `litecoin:${invoice.address}?amount=${coin}`
        : invoice.address;
      QRCode.toDataURL(payload, { width: 180, margin: 1, color: { dark: '#e2e8f0', light: '#0f172a' } })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(''));
    }
  }, [invoice?.address, invoice?.status, invoice?.amount_minor, invoice?.currency]);

  const create = async (e) => {
    e.preventDefault();
    if (cryptoOff) return;
    const amt = Number(amountUsd);
    if (!Number.isFinite(amt) || amt <= 0) { setErr('Enter a valid amount in USD.'); return; }
    setErr(''); setBusy(true);
    try {
      const d = await post('/api/deposits', { amount_usd: amt, currency });
      setInvoice(d.deposit);
      setHist((h) => [d.deposit, ...h.filter((x) => x.id !== d.deposit.id)]);
      setAmountUsd('');
      toast(`Deposit invoice ready — ${fmtCrypto(d.deposit.currency, d.deposit.amount_minor)} ${CUR[d.deposit.currency]?.fmt} to the address.`, 'success');
    } catch (x) {
      if (isDepositMaintenanceError(x)) maint.markMaintenance('crypto', x.message);
      setErr(x.message);
    } finally { setBusy(false); }
  };

  // Task 3 — real clipboard write with a legacy textarea fallback, and an honest
  // success/failure state instead of the old faked "Copied".
  const copyAddr = async () => {
    const addr = invoice?.address;
    if (!addr) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(addr);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = addr;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopyState(ok ? 'ok' : 'err');
    setTimeout(() => setCopyState(null), ok ? 1600 : 3000);
  };

  const cum = CUR[invoice?.currency] || { label: invoice?.currency, short: invoice?.currency, chain: '', fmt: invoice?.currency, decimals: 8 };
  // A partial ('in_progress') invoice is STILL payable — keep the address live.
  const awaiting = !!invoice && ['pending', 'in_progress'].includes(invoice.status);
  const pending = invoice && invoice.status === 'pending';
  const expiry = pending ? invoice.expires_at : null;
  const expired = expiry && expiry < now;

  return (
    <>
      <h1 className="page-title">Deposit</h1>
      <p className="page-sub">
        Pay in USD with crypto — credited to your wallet in INR at {fmtRateINR(rate)} per 1 USD.
        {sim && <span className="badge badge-warn" style={{ marginLeft: 10 }}>Simulated</span>}
      </p>
      <p className="faint" style={{ fontSize: '0.85rem', marginTop: -8 }}>
        Deposits are generally non-withdrawable. Read the <Link to="/refund-policy" className="muted">Refund &amp; Payment Policy</Link> before paying.
      </p>
      <DepositMaintenanceBanner status={maint.crypto} label="Crypto" />

      <div className="deposit-layout">
        {/* Left column */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-label">Select currency</div>
            <div className="stack" style={{ marginTop: 12 }}>
              {cryptos.map((c) => (
                <button key={c.id} type="button"
                  className={`btn ${currency === c.id ? 'btn-primary' : 'btn-outline'}`}
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => setCurrency(c.id)}>
                  <span className="flex between" style={{ width: '100%' }}>
                    <span>{CUR[c.id]?.label}</span>
                    <span className="flex">
                      {c.hot && <span className="badge badge-hot">HOT</span>}
                      {c.short}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="muted mt" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="globe" size={14} /> {CUR[currency]?.chain}. Credited at {fmtRateINR(rate)} per 1 USD.
            </p>
          </div>

          <div className="card">
            <form onSubmit={create}>
              <label className="label">Amount (USD)</label>
              <input className="input" type="number" min="0.01" step="0.01" value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)} placeholder="0.00" />
              {amountUsd && Number(amountUsd) > 0 && (
                (() => { // mirror the backend: cents → paise = round(usd×100) × rate
                  const paise = Math.round(Number(amountUsd) * 100) * rate;
                  return (
                    <div className="muted" style={{ fontSize: '0.9rem', marginTop: 8 }}>
                      <Icon name="coins" size={14} style={{ verticalAlign: '-2px' }} />{' '}
                      ≈ <b style={{ color: 'var(--text)' }}>{fmtInr(paise)}</b> credited
                    </div>
                  );
                })()
              )}
              {err && <div className="field-error"><Icon name="alert" size={15} /> {err}</div>}
              <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} disabled={busy || cryptoOff}>
                {busy ? 'Creating invoice…' : 'Create Deposit Invoice'}
              </button>
            </form>
          </div>
        </div>

        {/* Right column — reopened invoice */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 320 }}>
          {!invoice ? (
            <div className="empty" style={{ margin: 'auto', padding: 48 }}>
              <div className="empty-icon" style={{ color: 'var(--accent-2)', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)' }}>
                <Icon name="coins" size={26} stroke={1.5} />
              </div>
              <div className="empty-text">No active invoice</div>
              <div className="empty-sub">Create an invoice to see a deposit address and QR code.</div>
            </div>
          ) : (
            <>
              <div className="flex between wrap">
                <div>
                  <div className="card-label">Deposit {cum.label}</div>
                  <div className="card-value" style={{ fontSize: '1.7rem' }}>
                    {invoice.amount_minor > 0 ? (
                      <>
                        {fmtCrypto(invoice.currency, invoice.amount_minor)}{' '}
                        <span className="faint" style={{ fontSize: '1rem' }}>{cum.fmt}</span>
                      </>
                    ) : fmtUsd((invoice.amount_usd || 0) / 100)}
                  </div>
                  <div className="muted" style={{ fontSize: '0.88rem' }}>
                    {pending
                      ? `≈ ${fmtUsd((invoice.amount_usd || 0) / 100)} · expected credit ${fmtInr(Math.round((invoice.amount_usd || 0) * rate))}`
                      : invoice.status === 'in_progress'
                        ? `≈ ${fmtInr(invoice.amount_inr || 0)} credited so far${invoice.amount_usd ? ` of ${fmtUsd(invoice.amount_usd / 100)}` : ''}`
                        : `≈ ${fmtInr(invoice.amount_inr || 0)} credited`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {pending && (
                    <div className={`badge ${expired ? 'badge-danger' : 'badge-info'}`}>
                      <span className="dot" style={{ background: expired ? 'var(--danger)' : 'var(--warn)' }} />
                      {expired ? 'Expired' : clockTil(expiry)}
                    </div>
                  )}
                  {!pending && (
                    <div className={`badge ${invoice.status === 'confirmed' ? 'badge-success' : invoice.status === 'in_progress' ? 'badge-info' : 'badge-muted'}`}>
                      <span className="dot" style={{ background: invoice.status === 'confirmed' ? 'var(--success)' : invoice.status === 'in_progress' ? 'var(--info)' : 'var(--faint)' }} />
                      {invoice.status === 'confirmed' ? 'Confirmed' : invoice.status === 'in_progress' ? 'Partially received' : invoice.status}
                    </div>
                  )}
                </div>
              </div>

              {/* Payment status — PENDING is never labeled "confirmed" */}
              {awaiting && (
                <div className="payment-status pending" role="status" aria-live="polite">
                  <span className="dot pulse" style={{ background: expired ? 'var(--danger)' : 'var(--warn)' }} />
                  {expired
                    ? 'Invoice expired — no payment received. Create a new deposit.'
                    : invoice.status === 'in_progress'
                      ? 'Partial payment received — the rest is still due. The address stays valid.'
                      : 'Waiting for payment. Your wallet is credited the moment the payment is confirmed.'}
                </div>
              )}
              {!awaiting && invoice.status === 'confirmed' && (
                <div className="payment-status confirmed">
                  <span className="dot" style={{ background: 'var(--success)' }} />
                  Payment received and wallet credited.
                </div>
              )}

              {awaiting && (
                <div className="qr-section">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="Deposit QR code" className="qr-img" />
                  ) : (
                    <div className="qr-placeholder">
                      <Icon name="qr" size={32} stroke={1.3} />
                    </div>
                  )}

                  <div className="card" style={{ marginTop: 14, background: 'var(--bg-elev)', boxShadow: 'none' }}>
                    <div className="row-label mb" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      Send {cum.fmt} to this address
                    </div>
                    <div className="flex" style={{ gap: 8 }}>
                      <code className="input mono inline-code" style={{ fontSize: '0.88rem', flex: 1 }}>{invoice.address}</code>
                      <button className="btn btn-outline btn-sm" onClick={copyAddr}
                        style={{ whiteSpace: 'nowrap', minWidth: 78 }}
                        aria-live="polite"
                        aria-label="Copy deposit address">
                        {copyState === 'err' ? (
                          <><Icon name="alert" size={14} /> Failed</>
                        ) : copyState === 'ok' ? (
                          <><Icon name="check" size={14} stroke={2.5} /> Copied</>
                        ) : (
                          <><Icon name="copy" size={14} /> Copy</>
                        )}
                      </button>
                    </div>
                    <p className="muted mt" style={{ fontSize: '0.86rem', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <Icon name="lock" size={14} style={{ marginTop: 3, flexShrink: 0 }} />
                      <span>Send the exact amount. Your wallet is credited automatically once confirmed
                        {invoice.is_simulated ? ' (simulated)' : ' on-chain'}.</span>
                    </p>
                    {sim && !invoice.is_simulated && (
                      <div className="faint" style={{ fontSize: '0.82rem', marginTop: 6 }}>Simulation mode — test address only, no real funds tracked.</div>
                    )}
                  </div>
                </div>
              )}

              {/* Verified receipt on a confirmed deposit — real crypto amount + tx */}
              {invoice.status === 'confirmed' && (
                <div className="card" style={{ marginTop: 14, background: 'var(--bg-elev)', boxShadow: 'none' }}>
                  <div className="row-label mb">Verified receipt</div>
                  <div className="stack" style={{ gap: 6, fontSize: '0.88rem' }}>
                    {invoice.received_minor > 0 && (
                      <div className="flex between">
                        <span className="muted">Received</span>
                        <b>{fmtCrypto(invoice.currency, invoice.received_minor)} {cum.fmt}</b>
                      </div>
                    )}
                    {invoice.tx_hash && (
                      <div className="flex between" style={{ gap: 12, alignItems: 'flex-start' }}>
                        <span className="muted" style={{ flexShrink: 0 }}>Transaction</span>
                        <code className="mono faint" style={{ wordBreak: 'break-all', textAlign: 'right', fontSize: '0.8rem' }} title={invoice.tx_hash}>
                          {invoice.tx_hash}
                        </code>
                      </div>
                    )}
                    <div className="flex between">
                      <span className="muted">Network</span>
                      <span>{cum.chain}</span>
                    </div>
                  </div>
                </div>
              )}

              <button className="btn btn-ghost btn-sm" style={{ marginTop: 12, alignSelf: 'flex-end' }}
                onClick={() => { setInvoice(null); setCopyState(null); }}>
                <Icon name="close" size={13} stroke={2.2} /> Close invoice
              </button>

              <div className="divider" />

              <h3 style={{ fontWeight: 800, color: 'var(--text)', marginBottom: 12 }}>Deposit history</h3>
              {hist.length === 0 ? (
                <p className="faint" style={{ fontSize: '0.9rem' }}>No deposits yet.</p>
              ) : (
                <div className="table-wrap" style={{ border: 'none' }}>
                  <table>
                    <thead><tr><th>Amount</th><th>Coin</th><th>Status</th><th>When</th></tr></thead>
                    <tbody>
                      {hist.map((d) => {
                        const dr = CUR[d.currency] || { short: d.currency, decimals: 8 };
                        const reopenable = ['pending', 'in_progress'].includes(d.status);
                        return (
                          <tr key={d.id}
                            onClick={() => openInvoice(d.id)}
                            style={{ cursor: 'pointer' }}
                            title={reopenable ? 'Open this invoice' : 'View details'}>
                            <td>
                              {d.status === 'in_progress' || d.status === 'confirmed'
                                ? (d.received_minor > 0
                                  ? `${fmtCrypto(d.currency, d.received_minor)} ${dr.short}`
                                  : fmtUsd((d.amount_usd || 0) / 100))
                                : fmtUsd((d.amount_usd || 0) / 100)}
                              <div className="faint" style={{ fontSize: '0.78rem' }}>
                                {d.status === 'confirmed' ? `≈ ${fmtInr(d.amount_inr)} credited` : `≈ ${fmtInr(Math.round((d.amount_usd || 0) * rate))} expected`}
                              </div>
                            </td>
                            <td>
                              <span className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                                {dr.short}
                                {invoice?.id === d.id && <span className={`badge ${awaiting ? 'badge-info' : 'badge-muted'}`}>open</span>}
                                {d.is_simulated && <span className="badge badge-muted" style={{ fontSize: '0.65rem' }}>SIM</span>}
                              </span>
                              {d.tx_hash && <div className="mono faint" style={{ fontSize: '0.7rem', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.tx_hash}>{d.tx_hash}</div>}
                            </td>
                            <td>
                              <span className={`badge ${d.status === 'confirmed' ? 'badge-success' : d.status === 'pending' ? 'badge-warn' : d.status === 'in_progress' ? 'badge-info' : 'badge-muted'}`}>
                                <span className="dot" style={{ background: d.status === 'confirmed' ? 'var(--success)' : d.status === 'pending' ? 'var(--warn)' : d.status === 'in_progress' ? 'var(--info)' : 'var(--faint)' }} />
                                {d.status === 'in_progress' ? 'partial' : d.status}
                              </span>
                            </td>
                            <td className="faint">{timeAgo(d.created_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}