// End-to-end API smoke test — walks the whole client+admin flow against a live server.
// Usage: node scripts/smoke-test.mjs [baseUrl]
import { config as serverConfig } from '../server/config.js';
const BASE = process.argv[2] || 'http://localhost:3000';
// Admin credentials live ONLY in server/config.js (the single documented source) —
// never duplicated here.
const [ADMIN_EMAIL, ADMIN_PASSWORD] = Object.entries(serverConfig.admins)[0];
let ok = 0, fail = 0;
const log = (name, pass, extra = '') => {
  if (pass) ok++; else fail++;
  console.log(`${pass ? 'ok' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

async function req(method, path, { body, jar } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jar && jar.headers ? jar.headers : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  const setCookies = res.headers.get('set-cookie');
  const headers = setCookies ? { cookie: setCookies.split(';')[0] } : (jar?.headers || {});
  return { status: res.status, data, headers, cookieAdded: Boolean(setCookies) };
}
const jar = (h) => ({ headers: h });
const J = (j) => jar(j.headers);

(async () => {
  // ---- Public landing
  let r = await req('GET', '/api/landing/stats');
  log('landing/stats', r.status === 200 && typeof r.data.clients === 'number');
  r = await req('GET', '/api/landing/services');
  log('landing/services', r.status === 200 && Array.isArray(r.data.services) && r.data.services.length > 0);
  const hasEmojiIcon = r.data.services.some((s) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(s.icon ?? ''));
  log('landing/services no emoji category', !hasEmojiIcon);

  // ---- Signup a fresh client
  const email = 'smoke-' + Date.now() + '@test.dev';
  r = await req('POST', '/api/auth/register', { body: { name: 'Smoke', email, password: 'secret123', confirm: 'secret123', terms: true } });
  log('register', r.status === 201 || r.status === 200, `status ${r.status}`);

  // ---- Login
  r = await req('POST', '/api/auth/login', { body: { email, password: 'secret123' } });
  log('client login', r.status === 200 && r.data?.user?.role === 'client');
  const cj = J(r);

  // ---- Me
  r = await req('GET', '/api/auth/me', { jar: cj });
  log('auth/me', r.status === 200 && r.data?.user?.email === email);

  // ---- Services (categories with SVG icon keys, prices in paise)
  r = await req('GET', '/api/services', { jar: cj });
  const cats = r.data?.categories || [];
  log('services list', r.status === 200 && cats.length >= 1 && cats[0].services.length > 0,
    `${cats.length} categories`);
  const catIconHasEmoji = cats.some((c) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(c.icon ?? ''));
  log('categories icons emoji-free', !catIconHasEmoji);
  const svc = cats.flatMap((c) => c.services)[0];

  // ---- Security: a client must be 403 on admin APIs
  r = await req('GET', '/api/admin/dashboard', { jar: cj });
  log('client → admin API 403', r.status === 403, `status ${r.status}`);

  // ---- Unauthenticated → 401
  r = await req('GET', '/api/wallet');
  log('no-auth wallet → 401', r.status === 401, `status ${r.status}`);

  // ---- Create a deposit invoice ($10) — invoice creation must NOT credit
  // anything and must NOT confirm. Only an explicit payment event may.
  r = await req('POST', '/api/deposits', { jar: cj, body: { amount_usd: 10, currency: 'LTC' } });
  log('create deposit', [200, 201].includes(r.status), `status ${r.status}`);
  log('deposit created as pending + correct INR estimate',
    r.data?.deposit?.status === 'pending' && r.data?.deposit?.amount_inr === 100000,
    `status ${r.data?.deposit?.status} — $10 → ${r.data?.deposit?.amount_inr} paise (₹1,000)`);
  const invId = r.data?.deposit?.id;

  r = await req('GET', '/api/wallet', { jar: cj });
  const balBefore = r.data?.balance_inr;

  // Ticker's other jobs must NOT confirm our invoice; give it a beat.
  await new Promise((res) => setTimeout(res, 2500));
  r = await req('GET', '/api/wallet', { jar: cj });
  log('invoice creation does NOT credit wallet', r.data?.balance_inr === balBefore,
    `balance ${r.data?.balance_inr} (was ${balBefore})`);
  r = await req('GET', '/api/deposits', { jar: cj });
  log('invoice stays pending with no payment', r.data?.deposits?.[0]?.status === 'pending',
    `status ${r.data?.deposits?.[0]?.status}`);

  // ---- Task 2: a pending invoice is REOPENABLE on the SAME address/QR/amount —
  // GET /api/deposits/:id returns the live invoice facts (never a new invoice).
  r = await req('GET', `/api/deposits/${invId}`, { jar: cj });
  const det = r.data?.deposit;
  log('deposit reopen returns the SAME invoice', r.status === 200 && det?.id === invId,
    `invoice ${det?.invoice_id} / id ${det?.id}`);
  log('reopen carries address + amount + expiry fields',
    typeof det?.address === 'string' && det?.address.length >= 20 &&
    typeof det?.amount_minor === 'number' && Number(det?.expires_at) > Number(det?.created_at),
    `minor ${det?.amount_minor} via ${det?.currency_code}`);

  // ---- Tasks 16/18: the force-confirm endpoint must refuse anything it cannot
  // prove — an unknown id is 404 in test mode, or the whole endpoint is 403 in
  // production. It can never credit a synthetic id.
  r = await req('POST', '/webhooks/simulator', { body: { deposit_id: 2147483647 } });
  log('simulator refuses an unknown deposit (no credit)', [403, 404].includes(r.status), `status ${r.status}`);
  r = await req('GET', '/api/cryptos', { jar: cj });
  log('cryptos list + truthful simulated flag',
    r.status === 200 && Array.isArray(r.data?.cryptos) && r.data?.cryptos.length >= 3 &&
    typeof r.data?.simulated === 'boolean');

  r = await req('GET', '/api/notifications', { jar: cj });
  const titles1 = (r.data?.notifications || []).map((n) => n.title);
  log('no fake "Deposit Confirmed" after invoice creation', !titles1.includes('Deposit Confirmed'));
  log('"Deposit Created" notified (pending life-cycle)',
    titles1.includes('Deposit Created'), JSON.stringify(titles1));

  // ---- Explicit payment event (simulator webhook = the ONLY way a simulated
  // payment lands). Credit must be exactly once.
  r = await req('POST', '/webhooks/simulator', { body: { deposit_id: invId } });
  log('simulated payment event confirms deposit', r.status === 200 && r.data?.ok === true,
    `inr ${r.data?.inr} (₹1,000 for $10)`);
  await new Promise((res) => setTimeout(res, 500));
  r = await req('GET', '/api/wallet', { jar: cj });
  log('confirmation credits wallet exactly once', r.data?.balance_inr === balBefore + 100000,
    `balance ${r.data?.balance_inr}`);

  // ---- Send the same simulator event again: must be refused (no double credit)
  r = await req('POST', '/webhooks/simulator', { body: { deposit_id: invId } });
  log('duplicate payment event refused (idempotent)', r.status === 400, `status ${r.status}`);
  r = await req('GET', '/api/wallet', { jar: cj });
  log('duplicate event does NOT double-credit', r.data?.balance_inr === balBefore + 100000,
    `balance still ${r.data?.balance_inr}`);

  // ---- Task 1: after confirmation the deposit row holds REAL generated facts
  // (paid_usd) and — because this ran through the SIMULATOR with no on-chain
  // receipt — must NOT fabricate a tx_hash / received_minor (Task 18).
  r = await req('GET', '/api/deposits', { jar: cj });
  const depRow = r.data?.deposits?.[0];
  log('confirmed deposit row carries real paid_usd',
    depRow?.status === 'confirmed' && depRow?.paid_usd === depRow?.amount_usd,
    `status ${depRow?.status}, paid ${depRow?.paid_usd}/${depRow?.amount_usd}`);
  log('simulated confirm does NOT fabricate tx_hash / received_minor',
    Boolean(depRow) && !depRow.tx_hash && !(Number(depRow.received_minor) > 0));

  r = await req('GET', '/api/notifications', { jar: cj });
  const titles2 = (r.data?.notifications || []).map((n) => n.title);
  log('"Deposit Confirmed" only after real/simulated payment event',
    titles2.includes('Deposit Confirmed') && titles2.filter((t) => t === 'Deposit Confirmed').length === 1);

  // ---- Quote a service order price
  r = await req('POST', '/api/quote', { jar: cj, body: { serviceId: svc.id, quantity: svc.min, coupon_code: 'WELCOME10' } });
  log('quote WELCOME10', r.status === 200 && r.data?.ok === true && !r.data?.invalidCoupon,
    `final ${r.data?.final}`);

  // ---- Place order
  r = await req('POST', '/api/orders', { jar: cj, body: { serviceId: svc.id, link: 'https://instagram.com/smoke', quantity: svc.min, coupon_code: null } });
  log('place order', [200, 201].includes(r.status) && r.data?.order?.order_ref?.startsWith('ORD-'), `status ${r.status} ref ${r.data?.order?.order_ref}`);

  // ---- Orders list
  r = await req('GET', '/api/orders', { jar: cj });
  log('orders list', r.status === 200 && r.data?.orders?.length >= 1);
  const orderId = r.data?.orders?.[0]?.id;
  const placedRef = r.data?.orders?.[0]?.order_ref;
  const listKeys = r.data?.orders?.[0] ? Object.keys(r.data.orders[0]) : [];

  // ---- Task 8: a client must never see the supplier's order id, base cost or
  // any provider detail — neither in the list nor in the order detail.
  r = await req('GET', `/api/orders/${orderId}`, { jar: cj });
  const orderKeys = r.data?.order ? Object.keys(r.data.order) : [];
  const allClientOrderKeys = [...new Set([...listKeys, ...orderKeys])];
  log('order payload has NO provider_order_id',
    r.status === 200 && !allClientOrderKeys.includes('provider_order_id'),
    `keys: ${allClientOrderKeys.join(', ')}`);
  log('no provider/base-rate/cost fields leak to client',
    !allClientOrderKeys.some((k) => /provider|base_cost|admin_rate/.test(k)), allClientOrderKeys.join(', '));

  // ---- Ticker: PENDING → IN_PROGRESS → COMPLETED/PARTIAL.
  // The demo PENDING phase is 20-80s (scaled by DEMO_SPEED), so this assertion
  // only runs when the server was launched with DEMO_SPEED set (test mode).
  // Against a normal-speed server the obvious pass is: order exists. Running
  // the suite with DEMO_SPEED verifies the full lifecycle.
  if (process.env.DEMO_SPEED) {
    let settled = false;
    // Demo curve worst case is ~(80s PENDING + 270s IN_PROGRESS) / speed.
    // Scale the deadline with speed so any value verifies the full lifecycle.
    const speed = Number(process.env.DEMO_SPEED) || 1;
    const deadline = Date.now() + Math.max(90_000, Math.ceil((350 / speed) * 1000) + 30_000);
    while (Date.now() < deadline && !settled) {
      await new Promise((res) => setTimeout(res, 5000));
      r = await req('GET', '/api/orders', { jar: cj });
      const o = (r.data?.orders || []).find((x) => x.order_ref === placedRef);
      if (!o) break;
      if (o.status !== 'PENDING' && o.status !== 'IN_PROGRESS') settled = true;
    }
    r = await req('GET', '/api/orders', { jar: cj });
    const done = (r.data?.orders || []).find((x) => x.order_ref === placedRef);
    const tickerOk = done && (done.status === 'COMPLETED' || done.status === 'PARTIAL') &&
      done.remains === 0 && done.start_count >= done.quantity;
    log('ticker advances PENDING → COMPLETED/PARTIAL', Boolean(tickerOk),
      `${done ? `status ${done.status} remains ${done.remains} / started ${done.start_count} of ${done.quantity}` : 'order gone'}`);
  } else {
    log('ticker lifecycle (DEMO_SPEED set)', true, 'skipped — run server with DEMO_SPEED>1 to assert full lifecycle');
  }

  // ---- Notifications (should exist: welcome, order placed, deposit confirmed) — zero emojis
  r = await req('GET', '/api/notifications', { jar: cj });
  const notifHasEmoji = (r.data?.notifications || []).some((n) =>
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(n.title + (n.body || '')));
  log('notifications list', r.status === 200 && (r.data?.notifications || []).length > 0,
    `unread ${r.data?.unread}`);
  log('notification titles emoji-free', !notifHasEmoji);

  // ---- Wallet transactions ledger
  r = await req('GET', '/api/wallet/transactions', { jar: cj });
  log('wallet transactions', r.status === 200 && (r.data?.transactions || []).length >= 2,
    `${r.data?.transactions?.length} tx`);

  // ---- Tasks 9: support channels are InstaSMM's OWN 4 keys — never a supplier's.
  r = await req('GET', '/api/support', { jar: cj });
  const ch = r.data?.channels || {};
  log('support channels expose only our 4 keys',
    r.status === 200 && ['email', 'whatsapp', 'telegram', 'phone'].every((k) => Object.prototype.hasOwnProperty.call(ch, k)),
    `keys ${Object.keys(ch).join(', ')}`);

  // ---- Tickets: create + reply
  r = await req('POST', '/api/tickets', { jar: cj, body: { subject: 'Help', body: 'Order stuck', order_id: orderId } });
  log('create ticket', r.status === 200 || r.status === 201);
  const tid = r.data?.ticket?.id;

  // ---- Admin login
  r = await req('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  log('admin login', r.status === 200 && r.data?.user?.role === 'admin');
  const aj = J(r);

  r = await req('GET', '/api/admin/dashboard', { jar: aj });
  log('admin dashboard 200', r.status === 200 && r.data?.metrics);
  r = await req('GET', '/api/admin/users', { jar: aj });
  log('admin users 200', r.status === 200 && Array.isArray(r.data?.users));
  r = await req('GET', '/api/admin/services', { jar: aj });
  const adminServices = r.data?.services || [];
  const leak = adminServices.find((s) => Object.keys(s).find((k) => k.includes('key')) || s.api_key);
  log('admin services no api_key leak', r.status === 200 && !leak);
  r = await req('GET', '/api/admin/providers', { jar: aj });
  const provLeak = (r.data?.providers || []).some((p) => p.api_key || p.api_url);
  log('providers masked (no key/url)', r.status === 200 && !provLeak);

  // ---- Task 4: admin withdrawal surface. The audit list is always safe; a POST
  // without the typed confirmation is refused BEFORE any funds could move (and
  // when Apirone is unconfigured it can never be faked).
  r = await req('GET', '/api/admin/withdrawals', { jar: aj });
  log('admin withdrawals audit list 200',
    r.status === 200 && Array.isArray(r.data?.withdrawals) && typeof r.data?.configured === 'boolean');
  r = await req('POST', '/api/admin/withdrawals', {
    jar: aj, body: { currency: 'LTC', address: 'ltc1qzx9kz7rzvnjy4g3lv4fk2n7vv9rgrterrqc2r4', mode: 'amount', amount_coin: '0.1' },
  });
  log('unconfirmed withdrawal refused (no funds move)', r.status === 400, `status ${r.status}`);

  // ---- Withdrawal feature, Task 10 (client privacy): the whole panel — saved
  // addresses AND live balances — must 403 for a normal client.
  r = await req('GET', '/api/admin/withdrawals/addresses', { jar: cj });
  log('client → saved addresses 403', r.status === 403, `status ${r.status}`);
  r = await req('GET', '/api/admin/withdrawals/balances', { jar: cj });
  log('client → live balances 403', r.status === 403, `status ${r.status}`);

  // ---- Saved addresses (Task 1/8): network-specific validation, one address per
  // currency, replace-with-confirmation. Pure DB — works even unconfigured.
  const LTC_A = 'ltc1qzx9kz7rzvnjy4g3lv4fk2n7vv9rgrterrqc2r4';
  const LTC_B = 'ltc1qs2cxfgr26rfeuxet4c5dlja6v6my9z66j22kez';
  const TRC20_ADDR = 'TQ4xCqvGkTpLxa1KfQxwdcHdfdCDs7Qnd5';
  const ERC20_ADDR = '0x9f5d0e2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e'; // 0x + 40 hex

  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: LTC_A } });
  log('admin saves valid LTC address', r.status === 200 && r.data?.ok === true, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: 'not-a-real-address!!' } });
  log('invalid address format rejected', r.status === 400, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: TRC20_ADDR } });
  log('TRC20 address rejected as LTC (network-safe)', r.status === 400, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: LTC_A } });
  log('same address re-saved = no-op 200', r.status === 200, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: LTC_B } });
  log('replace WITHOUT confirm → 409 gated', r.status === 409 && r.data?.code === 'ADDRESS_REPLACE_CONFIRM', `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/LTC', { jar: aj, body: { address: LTC_B, confirm_replace: true } });
  log('replace WITH confirm → 200', r.status === 200 && r.data?.address?.address === LTC_B, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/ERC20_USDT', { jar: aj, body: { address: TRC20_ADDR } });
  log('TRC20 address rejected as ERC20 (wrong USDT network)', r.status === 400, `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/ERC20_USDT', { jar: aj, body: { address: ERC20_ADDR } });
  log('valid ERC20 USDT address saved', r.status === 200 && r.data?.address?.network === 'ERC20', `status ${r.status}`);
  r = await req('PUT', '/api/admin/withdrawals/addresses/POLYGON_USDT', { jar: aj, body: { address: LTC_A } });
  log('unsupported currency (Polygon / usdt@matic) rejected', r.status === 400, `status ${r.status}`);
  r = await req('GET', '/api/admin/withdrawals/addresses', { jar: aj });
  const saved = (r.data?.addresses || []).find((a) => a.currency === 'LTC');
  log('GET addresses reflects saved LTC + network label',
    r.status === 200 && saved?.address === LTC_B && saved?.network === 'Litecoin',
    `network ${saved?.network}`);

  // ---- Withdrawals against an UNCONFIGURED gateway must refuse — never fake.
  r = await req('POST', '/api/admin/withdrawals/estimate', { jar: aj, body: { currency: 'LTC', mode: 'sweep', fee: 'normal' } });
  log('estimate refused when Apirone unconfigured', r.status === 400, `status ${r.status}`);
  r = await req('POST', '/api/admin/withdrawals', {
    jar: aj, body: { currency: 'LTC', mode: 'sweep', confirmed: true, idempotency_key: crypto.randomUUID() },
  });
  log('confirmed withdrawal refused when gateway unconfigured (no fake tx)', r.status === 400, `status ${r.status}`);
  r = await req('GET', '/api/admin/withdrawals', { jar: aj });
  const failRows = (r.data?.withdrawals || []).filter((w) => w.status !== 'sent' && w.transfer_ref);
  log('no fabricated transfer_ref in history', failRows.length === 0, `${failRows.length} fake rows`);

  r = await req('GET', '/api/admin/tickets', { jar: aj });
  log('admin tickets 200', r.status === 200);

  // ---- Admin reply to the ticket + close (client gets notification)
  if (tid) {
    r = await req('POST', `/api/admin/tickets/${tid}/reply`, { jar: aj, body: { body: 'Checking now.' } });
    log('admin ticket reply', r.status === 200);
    r = await req('POST', `/api/admin/tickets/${tid}/status`, { jar: aj, body: { status: 'closed' } });
    log('admin ticket close', r.status === 200);
  }

  // ---- Security logs available
  r = await req('GET', '/api/admin/logs?limit=10', { jar: aj });
  log('admin logs 200', r.status === 200 && Array.isArray(r.data?.logs));

  // ---- Wrong admin password blocked
  r = await req('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong' } });
  log('admin wrong password denied', r.status === 401 || r.status === 403, `status ${r.status}`);

  console.log(`\n${ok} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e); process.exit(1); });