// ---------------------------------------------------------------------------
// VC Gateway status probe. Run it ON THE SERVER, once, against a real pending
// order you created (for example a ₹1 test deposit). It sends ONE read-only
// status request and prints a REDACTED summary: HTTP status, size, the names
// and JSON types of top-level fields, and the status value only when it is one
// of the documented five. It never prints the URL, the API key, or any value
// other than the status.
//
//   node scripts/vc-probe.mjs <ORDER_ID> <TOTAL_IN_RUPEES>
//   e.g. node scripts/vc-probe.mjs ORD261012ABCDEF 1.00
//
// It does not credit anything and does not change the database.
// ---------------------------------------------------------------------------
import { config } from '../server/config.js';
import { VC_PROTOCOL_CONTRACT, summarizeResponse, VC_MIN_PAISE } from '../server/lib/vcGatewayProtocol.js';
import { isValidOrderId } from '../server/lib/inrOrder.js';

const [orderId, amountArg] = process.argv.slice(2);
const fail = (msg) => { console.error(`probe: ${msg}`); process.exit(2); };

if (!config.vcGetaway.apiKey) fail('VCGETAWAY_API_KEY is not set in this environment. Nothing was sent.');
if (!isValidOrderId(orderId)) fail('first argument must be an order ID such as ORD261012ABCDEF.');
if (!/^\d+(\.\d{1,2})?$/.test(String(amountArg || ''))) fail('second argument must be the TOTAL in rupees, such as 1.00 or 110.00.');

const [whole, frac = ''] = String(amountArg).split('.');
const totalPaise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
if (totalPaise < VC_MIN_PAISE) fail('the amount is below the provider minimum of ₹1.');

let req;
try {
  req = VC_PROTOCOL_CONTRACT.buildRequest({
    orderId,
    totalPaise,
    apiKey: config.vcGetaway.apiKey,
    apiUrl: config.vcGetaway.apiUrl,
  });
} catch (e) {
  // The error code is fixed text, so it is safe to print.
  fail(`request refused locally (${e.code || 'unknown'}). Check VCGETAWAY_API_URL.`);
}

let httpStatus = null;
let text = '';
try {
  const res = await fetch(req.url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  httpStatus = res.status;
  text = await res.text();
} catch (e) {
  // Network errors can echo the URL, so only the error name is printed.
  console.log(JSON.stringify({ result: 'no-response', errorName: e?.name || 'Error' }, null, 2));
  process.exit(1);
}

const summary = summarizeResponse({ httpStatus, text });
console.log(JSON.stringify({ result: 'response-received', ...summary }, null, 2));
