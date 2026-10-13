import { useEffect, useState } from 'react';
import { get, post, put } from '../../api.js';
import { useToast, timeAgo, fmtUsd, Icon, Modal } from '../../ui.jsx';

// Admin/Owner-only crypto withdrawal. Addresses are saved ONCE per currency and
// the withdrawal flow never asks for one again. Real Apirone transfers only —
// no simulation, no fabricated hashes. The gateway transfer key never leaves
// the server; the typed CONFIRM is a confirmation of intent, not a password.
const CUR = {
  LTC:        { label: 'Litecoin',     short: 'LTC',  net: 'Litecoin',  decimals: 8 },
  TRC20_USDT: { label: 'USDT (TRC20)', short: 'USDT', net: 'TRC20',     decimals: 6 },
  BEP20_USDT: { label: 'USDT (BEP20)', short: 'USDT', net: 'BEP20',     decimals: 6 },
  ERC20_USDT: { label: 'USDT (ERC20)', short: 'USDT', net: 'ERC20',     decimals: 6 },
};
// Requested network that the official Apirone API does not document — surfaced
// honestly instead of inventing a network code (never disabled silently).
const UNSUPPORTED = [
  { id: 'POLYGON_USDT', label: 'USDT (Polygon)', short: 'USDT', net: 'Polygon',
    reason: 'No usdt@matic code exists in the official Apirone v2 API' },
];

const coinOf = (minor, dec) => (Number(minor || 0) / Math.pow(10, dec)).toLocaleString('en-US', { maximumFractionDigits: dec });
const maskAddr = (a) => { a = String(a || ''); return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`; };
// "Sent" means the gateway accepted the transfer. On-chain confirmation is not
// verified here, so it is not labelled "Completed".
const STATUS = {
  sent: ['Sent to gateway', 'badge-success'],
  pending: ['Pending', 'badge-warn'],
  failed: ['Failed — nothing sent', 'badge-danger'],
  unknown: ['Unknown — do not retry, verify on gateway', 'badge-danger'],
};

export default function AdminWithdraw() {
  const toast = useToast();
  const [configured, setConfigured] = useState(false);
  const [balances, setBalances] = useState({});
  const [balFail, setBalFail] = useState([]);
  const [addresses, setAddresses] = useState({}); // currency → { address, network }
  const [history, setHistory] = useState([]);

  // Review & confirm modal (per-currency withdraw).
  const [review, setReview] = useState(null);       // currency id
  const [est, setEst] = useState(null);             // estimate response
  const [estBusy, setEstBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [idemKey, setIdemKey] = useState('');

  // Manage-saved-addresses modal.
  const [addrModal, setAddrModal] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [replacing, setReplacing] = useState({});   // currency → checkbox (replace)
  const [addrBusy, setAddrBusy] = useState(false);

  const load = async () => {
    try {
      const d = await get('/api/admin/withdrawals');
      setConfigured(d.configured);
      setHistory(d.withdrawals || []);
      setAddresses(Object.fromEntries((d.addresses || []).map((a) => [a.currency, a])));
      setDrafts(Object.fromEntries((d.addresses || []).map((a) => [a.currency, a.address])));
      if (d.configured) {
        try {
          const b = await get('/api/admin/withdrawals/balances');
          setBalances(b.balances || {});
          setBalFail(b.failures || []);
        } catch { /* gateway unreachable — balances stay absent (never fake) */ }
      }
    } catch { /* surface nothing — page stays up */ }
  };

  const reloadBalances = async () => {
    if (!configured) return;
    try {
      const b = await get('/api/admin/withdrawals/balances');
      setBalances(b.balances || {});
      setBalFail(b.failures || []);
    } catch { /* transient */ }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh idempotency key per withdraw intent (regenerated when the modal
  // re-opens) so a double-click can never double-pay.
  useEffect(() => { if (review) setIdemKey(crypto.randomUUID()); }, [review]);

  const openWithdraw = async (currency) => {
    if (!configured) { toast('Configure Apirone credentials in Settings first.', 'error'); return; }
    if (!addresses[currency]) { toast(`Save a ${CUR[currency].label} address first (Manage Saved Addresses).`, 'warn'); setAddrModal(true); return; }
    setReview(currency); setConfirmText(''); setEst(null);
  };

  // Fetch the official fee estimation BEFORE anything is sent (never executes).
  const runEstimate = async (currency) => {
    setEstBusy(true);
    try {
      const d = await post('/api/admin/withdrawals/estimate', { currency, mode: 'sweep', fee: 'normal', subtract_fee: true });
      setEst(d);
    } catch (x) { setEst(null); toast(x.message, 'error'); } finally { setEstBusy(false); }
  };

  const submit = async () => {
    if (!review) return;
    if (confirmText !== 'CONFIRM') { toast('You must type CONFIRM before anything is sent.', 'error'); return; }
    setBusy(true);
    try {
      const d = await post('/api/admin/withdrawals', {
        currency: review, mode: 'sweep', fee: 'normal', subtract_fee: true,
        confirmed: true, idempotency_key: idemKey,
      });
      const w = d?.withdrawal || {};
      toast(`Withdrawal submitted — gateway id ${w.transfer_ref || '…'}${w.tx_hash ? ` · tx ${w.tx_hash}` : ''}`, 'success');
      setReview(null); setConfirmText(''); setEst(null);
      load(); reloadBalances();
    } catch (x) {
      if (x.code === 'DUPLICATE') { toast(x.message || 'Already submitted — nothing duplicated.', 'warn'); setReview(null); }
      else toast(x.message, 'error');
    } finally { setBusy(false); }
  };

  const saveAddress = async (currency) => {
    const a = CUR[currency];
    const address = String(drafts[currency] || '').trim();
    if (!address) { toast('Enter an address.', 'error'); return; }
    setAddrBusy(true);
    try {
      await put(`/api/admin/withdrawals/addresses/${currency}`, {
        address,
        confirm_replace: replacing[currency] === true,
      });
      toast(`${a.label} address saved.`, 'success');
      const d = await get('/api/admin/withdrawals/addresses');
      setAddresses(Object.fromEntries(d.addresses.map((x) => [x.currency, x])));
    } catch (x) {
      if (x.code === 'ADDRESS_REPLACE_CONFIRM') {
        toast('That network already has an address — tick “replace” to swap it.', 'warn');
      } else {
        toast(x.message, 'error');
      }
    } finally { setAddrBusy(false); }
  };

  const c = (id) => CUR[id] || { short: id, decimals: 8 };

  return (
    <>
      <h1 className="page-title">Wallet / Withdraw</h1>
      <p className="page-sub">
        Real Apirone balances and owner-only withdrawals. Addresses are saved once per network;
        the gateway transfer key never leaves the server.
      </p>

      <div className="flex wrap" style={{ gap: 10, marginBottom: 18 }}>
        <button className="btn btn-outline btn-sm" onClick={() => setAddrModal(true)}>
          <Icon name="edit" size={14} stroke={2} /> Manage Saved Addresses
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => { load(); reloadBalances(); }}>
          <Icon name="refresh" size={14} stroke={2} /> Refresh balances
        </button>
        {!configured && (
          <span className="badge badge-warn">Apirone not configured — withdrawals disabled (no fakes)</span>
        )}
      </div>

      {/* ===== WALLET — real balances, saved address, Withdraw ===== */}
      <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <div className="row-label" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)' }}>
          <Icon name="wallet" size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} /> Wallet
        </div>
        <div className="table-wrap" style={{ border: 'none' }}>
          <table>
            <thead><tr><th>Currency / network</th><th>Balance</th><th>Saved address</th><th /></tr></thead>
            <tbody>
              {Object.keys(CUR).map((id) => {
                const w = c(id);
                const bal = balances[id];
                const saved = addresses[id];
                const unreachable = !configured || (bal == null);
                const hasBalance = !unreachable && bal > 0;
                return (
                  <tr key={id}>
                    <td>
                      <b>{w.label}</b>
                      <div className="faint" style={{ fontSize: '0.78rem' }}>{w.net}</div>
                    </td>
                    <td className="mono">
                      {unreachable ? <span className="faint">—</span> : `${coinOf(bal, w.decimals)} ${w.short}`}
                      {balFail.includes(id) && <span className="faint" style={{ fontSize: '0.75rem', marginLeft: 6 }}>(unavailable)</span>}
                    </td>
                    <td>
                      {saved ? (
                        <code className="mono" style={{ fontSize: '0.78rem', wordBreak: 'break-all' }} title={saved.address}>
                          {maskAddr(saved.address)}
                        </code>
                      ) : (
                        <span className="faint" style={{ fontSize: '0.8rem' }}>No address saved</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-primary btn-sm" disabled={!configured || !saved || !hasBalance}
                        onClick={() => openWithdraw(id)} title={!saved ? 'Save this network’s address first' : ''}>
                        <Icon name="send" size={14} stroke={2.2} /> Withdraw
                      </button>
                    </td>
                  </tr>
                );
              })}
              {UNSUPPORTED.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span style={{ opacity: 0.6 }}>{u.label}</span>
                    <div className="faint" style={{ fontSize: '0.78rem' }}>{u.net}</div>
                  </td>
                  <td colSpan={2}>
                    <span className="faint" style={{ fontSize: '0.8rem' }} title={u.reason}>
                      Not available — {u.reason}.
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm" disabled title={u.reason}>Withdraw</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== Withdrawal history ===== */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row-label" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)' }}>
          <Icon name="clock" size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} /> Withdrawal history
        </div>
        {history.length === 0 ? (
          <div className="empty" style={{ padding: 28 }}>
            <div className="empty-icon"><Icon name="send" size={30} stroke={1.4} /></div>
            <div className="empty-text">No withdrawals yet</div>
            <div className="empty-sub">Every transfer — sent or failed — is recorded here for audit.</div>
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Currency</th><th>Amount</th><th>Destination</th><th>Fee</th><th>Status</th><th>Ref / Tx</th><th>Created</th><th>Completed</th></tr>
              </thead>
              <tbody>
                {history.map((w) => {
                  const wc = c(w.currency);
                  const [stLabel, stCls] = STATUS[w.status] || [w.status, 'badge-muted'];
                  return (
                    <tr key={w.id}>
                      <td>
                        <b>{wc.short}</b>
                        <div className="faint" style={{ fontSize: '0.75rem' }}>{w.network || wc.net || w.currency}</div>
                      </td>
                      <td>
                        <span className="mono">{w.mode === 'sweep' ? `100% (${coinOf(w.amount_minor, wc.decimals)} ${wc.short})` : `${coinOf(w.amount_minor, wc.decimals)} ${wc.short}`}</span>
                        {w.amount_usd ? <div className="faint" style={{ fontSize: '0.75rem' }}>≈ {fmtUsd(w.amount_usd / 100)}</div> : null}
                      </td>
                      <td><code className="mono faint" style={{ fontSize: '0.78rem' }}>{w.address_masked || maskAddr(w.address)}</code></td>
                      <td className="mono faint" style={{ fontSize: '0.8rem' }}>{w.fee}</td>
                      <td><span className={`badge ${stCls}`}><span className="dot" style={{ background: w.status === 'sent' ? 'var(--success)' : w.status === 'failed' ? 'var(--danger)' : 'var(--warn)' }} />{stLabel}</span></td>
                      <td className="mono faint" style={{ fontSize: '0.75rem', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`ref ${w.transfer_ref || '—'}${w.tx_hash ? `\ntx ${w.tx_hash}` : ''}`}>
                        {w.tx_hash ? <>tx {w.tx_hash.slice(0, 14)}…</> : (w.transfer_ref ? `ref ${w.transfer_ref}` : '—')}
                      </td>
                      <td className="faint">{timeAgo(w.created_at)}</td>
                      <td className="faint">{w.executed_at ? timeAgo(w.executed_at) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {history.some((w) => w.status === 'failed' && w.error) && (
          <div style={{ padding: '12px 18px' }}>
            {history.filter((w) => w.status === 'failed').slice(0, 5).map((w) => (
              <div key={w.id} className="faint" style={{ fontSize: '0.8rem', marginBottom: 4 }}>
                <b>#{w.id}</b> {w.error}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== Withdraw → confirm (estimate + typed CONFIRM) ===== */}
      {review && (
        <Modal onClose={() => !busy && setReview(null)} title="Confirm withdrawal">
          <div className="stack" style={{ gap: 10 }}>
            <div className="card" style={{ background: 'var(--bg-elev)', boxShadow: 'none', padding: 14 }}>
              <div className="flex between"><span className="muted">Currency / network</span><b>{c(review).label} · {c(review).net}</b></div>
              <div className="flex between" style={{ alignItems: 'flex-start' }}><span className="muted">To (saved address)</span>
                <code className="mono" style={{ wordBreak: 'break-all', textAlign: 'right', fontSize: '0.82rem', maxWidth: '70%' }}>
                  {maskAddr(addresses[review]?.address)}
                </code>
              </div>
              <div className="flex between"><span className="muted">Available balance</span>
                <b className="mono">{balances[review] != null ? `${coinOf(balances[review], c(review).decimals)} ${c(review).short}` : '—'}</b>
              </div>
            </div>

            <div className="flex" style={{ gap: 10 }}>
              <button className="btn btn-outline btn-sm" onClick={() => runEstimate(review)} disabled={estBusy}>
                {estBusy ? 'Checking…' : 'Estimate fee first'}
              </button>
              <span className="muted" style={{ fontSize: '0.8rem', alignSelf: 'center' }}>Nothing has been sent.</span>
            </div>

            {est && (
              <div className="card" style={{ background: 'var(--bg-elev)', boxShadow: 'none', padding: 14 }}>
                <div className="flex between"><span className="muted">Send (from wallet)</span><b className="mono">{coinOf(balances[review], c(review).decimals)} {c(review).short}</b></div>
                <div className="flex between"><span className="muted">Network fee</span><span className="mono">{coinOf(est.fees?.network, c(review).decimals)} {c(review).short} <span className="faint">(est.)</span></span></div>
                {Number(est.fees?.processing) > 0 && (
                  <div className="flex between"><span className="muted">Processing fee</span><span className="mono">{coinOf(est.fees.processing, c(review).decimals)} {c(review).short}</span></div>
                )}
                <div className="flex between"><span className="muted">Arrives at address ≈</span><b className="mono">{coinOf(est.net_estimate, c(review).decimals)} {c(review).short}</b></div>
                {est.ok === false && <p className="field-error"><Icon name="alert" size={15} /> Gateway estimate failed (HTTP {est.status || '?'}) — nothing was sent.</p>}
              </div>
            )}

            <p className="faint" style={{ fontSize: '0.83rem' }}>
              This sends real funds from the Apirone account. No separate password — your admin session
              authorizes this. The gateway transfer key never leaves the server; the result is audit-logged.
            </p>
            <label className="label">Type <b className="mono">CONFIRM</b> to enable the button</label>
            <input className="input mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder="CONFIRM" autoCapitalize="characters" autoComplete="off" />
            <div className="flex" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
              <button className="btn" onClick={() => setReview(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-danger" disabled={busy || confirmText !== 'CONFIRM'} onClick={submit}>
                {busy ? 'Sending…' : 'Send withdrawal'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ===== Manage Saved Addresses ===== */}
      {addrModal && (
        <Modal onClose={() => setAddrModal(false)} title="Manage saved addresses">
          <p className="faint" style={{ fontSize: '0.85rem', marginBottom: 12 }}>
            One address per network — validated here and used automatically at withdraw time. Replacing an
            existing address requires explicit confirmation.
          </p>
          <div className="stack" style={{ gap: 10 }}>
            {Object.keys(CUR).map((id) => {
              const w = c(id);
              const saved = addresses[id];
              const changed = saved && drafts[id]?.trim() && drafts[id].trim() !== saved.address;
              return (
                <div key={id} className="card" style={{ background: 'var(--bg-elev)', boxShadow: 'none', padding: 12 }}>
                  <div className="flex between" style={{ marginBottom: 6 }}>
                    <b style={{ color: 'var(--text)' }}>{w.label}</b>
                    <span className="badge badge-muted" style={{ fontSize: '0.7rem' }}>{w.net}</span>
                  </div>
                  {saved && !changed && (
                    <div className="muted" style={{ fontSize: '0.78rem', wordBreak: 'break-all', marginBottom: 6 }}>Saved: {saved.address}</div>
                  )}
                  <input className="input mono" value={drafts[id] || ''} onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
                    placeholder={`Paste a ${w.net} address…`} autoComplete="off" />
                  {changed && (
                    <label className="flex" style={{ gap: 8, marginTop: 8, cursor: 'pointer', alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={replacing[id] === true} onChange={(e) => setReplacing({ ...replacing, [id]: e.target.checked })} style={{ marginTop: 3 }} />
                      <span className="muted" style={{ fontSize: '0.82rem' }}>
                        Replace the existing address (the old one will stop being used).
                      </span>
                    </label>
                  )}
                  <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={addrBusy || !drafts[id]?.trim()}
                    onClick={() => saveAddress(id)}>
                    <Icon name="check" size={14} stroke={2.4} /> Save address
                  </button>
                </div>
              );
            })}
            <div className="card" style={{ background: 'var(--bg-elev)', boxShadow: 'none', padding: 12, opacity: 0.75 }}>
              <div className="flex between">
                <b>USDT (Polygon)</b><span className="badge badge-muted" style={{ fontSize: '0.7rem' }}>Polygon</span>
              </div>
              <p className="faint" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                Not supported — no Polygon network code in the official Apirone v2 API, so we do not save a
                fake address for it.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}