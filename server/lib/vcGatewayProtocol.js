// ---------------------------------------------------------------------------
// VC Gateway protocol, as documented by the provider. Pure: no database, no
// network, no config. Everything network-facing is in vcGatewayAdapter.js.
//
// Documented (provider documentation supplied to us):
//   endpoint  https://vcgatewaypro.com/payment_api.php
//   query     api_key, order_id, amount   (amount is in rupees; minimum ₹1)
//   statuses  SUCCESS, PENDING, FAILED, INVALID, NOT_FOUND
//
// NOT documented, and therefore NOT relied on here:
//   • the shape of the JSON response (field names, whether an order id or an
//     amount is echoed back, whether the amount is paise or rupees),
//   • whether SUCCESS means the payment is settled,
//   • a currency field, a provider transaction id, or webhook signing.
//
// Consequence: parseVerificationResponse reads the documented status and
// nothing else. It reports orderId and amountPaise as null, so the wallet
// classifier refuses to credit (order-mismatch). A SUCCESS can only become a
// credit once a reviewed response contract binds it to the order and amount.
// ---------------------------------------------------------------------------
import { isValidOrderId, paiseToRupeeString } from './inrOrder.js';

export const VC_DOCUMENTED_HOST = 'vcgatewaypro.com';
export const VC_DOCUMENTED_PATH = '/payment_api.php';
export const VC_DOCUMENTED_STATUSES = Object.freeze(['SUCCESS', 'PENDING', 'FAILED', 'INVALID', 'NOT_FOUND']);
export const VC_MIN_PAISE = 100;             // ₹1, documented minimum
export const VC_MAX_BODY_BYTES = 64 * 1024;  // a status reply is tiny; anything bigger is refused

// Errors carry a fixed code only. Messages never include the URL or the key.
export class VcProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VcProtocolError';
    this.code = code;
  }
}

// Builds the documented status request. Refuses anything except the documented
// HTTPS host and path, so a mis-set VCGETAWAY_API_URL cannot send the key elsewhere.
export function buildVerificationRequest({ apiUrl, apiKey, orderId, totalPaise }) {
  let u;
  try { u = new URL(String(apiUrl)); } catch { throw new VcProtocolError('bad-api-url'); }
  if (
    u.protocol !== 'https:' ||
    u.hostname !== VC_DOCUMENTED_HOST ||
    u.pathname !== VC_DOCUMENTED_PATH ||
    (u.port !== '' && u.port !== '443') ||
    u.username || u.password || u.search || u.hash
  ) {
    throw new VcProtocolError('bad-api-url');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0 || /\s/.test(apiKey)) {
    throw new VcProtocolError('bad-api-key');
  }
  if (!isValidOrderId(orderId)) throw new VcProtocolError('bad-order-id');
  if (!Number.isSafeInteger(totalPaise) || totalPaise < VC_MIN_PAISE) {
    throw new VcProtocolError('below-provider-minimum');
  }
  const query = new URLSearchParams({
    api_key: apiKey,
    order_id: orderId,
    amount: paiseToRupeeString(totalPaise),   // customer's TOTAL payable, in rupees
  });
  return { method: 'GET', url: `https://${VC_DOCUMENTED_HOST}${VC_DOCUMENTED_PATH}?${query.toString()}` };
}

// Reads the documented status. Throws VcProtocolError for anything else.
export function parseVerificationResponse(text) {
  if (typeof text !== 'string' || text.length === 0) throw new VcProtocolError('empty-body');
  if (Buffer.byteLength(text, 'utf8') > VC_MAX_BODY_BYTES) throw new VcProtocolError('body-too-large');
  let obj;
  try { obj = JSON.parse(text); } catch { throw new VcProtocolError('invalid-json'); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new VcProtocolError('not-an-object');
  if (typeof obj.status !== 'string' || !VC_DOCUMENTED_STATUSES.includes(obj.status)) {
    throw new VcProtocolError('undocumented-status');
  }
  // Order and amount are not documented in the response, so they are not read.
  return { status: obj.status, orderId: null, amountPaise: null };
}

// Contract object in the shape vcGatewayAdapter.js expects. documented is FALSE:
// production verification stays closed. The probe script and the mocked tests
// use this same code path, so what is tested is what would be sent.
export const VC_PROTOCOL_CONTRACT = Object.freeze({
  documented: false,
  buildRequest: ({ orderId, totalPaise, apiKey, apiUrl }) =>
    buildVerificationRequest({ apiUrl, apiKey, orderId, totalPaise }),
  parseResponse: parseVerificationResponse,
});

// Describes a provider reply WITHOUT its values: HTTP status, size, whether it
// is JSON, the top-level key names and their JSON types, and the status value
// only when it is one of the documented five. Safe to paste into a report.
export function summarizeResponse({ httpStatus, text }) {
  const body = typeof text === 'string' ? text : '';
  const out = { httpStatus, bytes: Buffer.byteLength(body, 'utf8') };
  let obj;
  try { obj = JSON.parse(body); } catch {
    out.json = false;
    out.bodyKind = /^\s*</.test(body) ? 'html-or-xml' : (body.trim() === '' ? 'empty' : 'text');
    return out;
  }
  out.json = true;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.topLevel = Array.isArray(obj) ? 'array' : (obj === null ? 'null' : typeof obj);
    return out;
  }
  out.topLevelKeys = Object.keys(obj).slice(0, 40).map((k) => ({
    key: k.slice(0, 64),
    type: obj[k] === null ? 'null' : Array.isArray(obj[k]) ? 'array' : typeof obj[k],
  }));
  out.status = VC_DOCUMENTED_STATUSES.includes(obj.status) ? obj.status : '[not a documented status]';
  return out;
}
