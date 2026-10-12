// ---------------------------------------------------------------------------
// VC Gateway adapter (INSTA SMM GATEWAY). Server-side only.
//
// Isolates every provider-specific detail so the wallet logic in
// inrVerification.js never depends on an unverified request or response
// format.
//
// THE VERIFICATION CONTRACT IS NOT DOCUMENTED. The supplied documentation
// gives one URL with api_key/order_id/amount and lists status names, but does
// not say whether that URL checks status, what the response looks like, how a
// response binds to an order and amount, or whether a webhook exists.
// DOCUMENTED_VERIFICATION_CONTRACT is therefore null. While it is null the
// adapter makes NO network request and reports "unavailable". Nothing in this
// file guesses a response format.
//
// To enable it later, a reviewed contract object must be supplied with:
//   documented: true
//   buildRequest({ orderId, totalPaise, apiKey }) -> { method, url, headers? }
//   parseResponse(text) -> { orderId, status, amountPaise }   (throws if malformed)
// ---------------------------------------------------------------------------
import { config } from '../config.js';

// Documented minimum deposit: ₹1. Applied to the amount sent to the gateway
// (the customer's total payable, in paise).
export const VC_MIN_PAISE = 100;
export const VC_TIMEOUT_MS = 10_000;

export const DOCUMENTED_VERIFICATION_CONTRACT = null;

// Removes the API key and any other secret from text before it is logged or
// returned. Also strips any api_key query parameter, whatever its value.
export function redactSecrets(text, extraSecrets = []) {
  let out = String(text ?? '');
  for (const s of [config.vcGetaway.apiKey, config.vcGetaway.webhookSecret, ...extraSecrets]) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  out = out.replace(/api_key=[^&\s"'<>]+/gi, 'api_key=[REDACTED]');
  return out.slice(0, 300);
}

async function defaultTransport(req, { timeoutMs }) {
  const res = await fetch(req.url, {
    method: req.method || 'GET',
    headers: req.headers || undefined,
    redirect: 'error',                       // never follow redirects with credentials
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

export function createVcGatewayAdapter({ contract = DOCUMENTED_VERIFICATION_CONTRACT, transport = defaultTransport } = {}) {
  const confirmed = Boolean(contract && contract.documented === true);
  return {
    isContractConfirmed: confirmed,

    // Returns one of:
    //   { state: 'unavailable', reason }  no usable contract, or the call failed
    //   { state: 'unverified',  reason }  amount below minimum, or malformed reply
    //   { state: 'response',    raw }     parsed reply, still to be classified
    async checkOrder({ orderId, totalPaise }) {
      if (!confirmed) return { state: 'unavailable', reason: 'verification-contract-not-confirmed' };
      if (!Number.isSafeInteger(totalPaise) || totalPaise < VC_MIN_PAISE) {
        return { state: 'unverified', reason: 'below-provider-minimum' };
      }
      let res;
      try {
        const req = contract.buildRequest({
          orderId,
          totalPaise,
          apiKey: config.vcGetaway.apiKey,
          apiUrl: config.vcGetaway.apiUrl,
        });
        res = await transport(req, { timeoutMs: VC_TIMEOUT_MS });
      } catch (e) {
        // Timeouts and network errors. The message may contain the URL, so it
        // is redacted and never returned to the customer.
        return { state: 'unavailable', reason: 'network', detail: redactSecrets(e?.message) };
      }
      if (!res || typeof res.text !== 'string' || res.status < 200 || res.status >= 300) {
        return { state: 'unavailable', reason: 'http-status' };
      }
      let raw;
      try {
        raw = contract.parseResponse(res.text);
      } catch {
        return { state: 'unverified', reason: 'malformed' };
      }
      if (raw === null || typeof raw !== 'object') return { state: 'unverified', reason: 'malformed' };
      // Register the reply as produced by this adapter. Issuance accepts only
      // registered replies, so a caller cannot hand in a forged reply object.
      adapterReplies.add(raw);
      return { state: 'response', raw };
    },
  };
}

// ---------------------------------------------------------------------------
// Trusted verifiers. Only an adapter in this module-private set may issue a
// verification token (see issueVerification in inrVerification.js). The set is
// not exported; the only ways in are the production adapter below and the
// test factory, which refuses to run outside the test suite. A plain object
// with isContractConfirmed: true is NOT trusted and can never mint a token.
// ---------------------------------------------------------------------------
const trustedVerifiers = new WeakSet();
const adapterReplies = new WeakSet();
export function isAdapterIssuedReply(raw) {
  return raw !== null && typeof raw === 'object' && adapterReplies.has(raw);
}
export function isTrustedVerifier(adapter) {
  return adapter !== null && typeof adapter === 'object' && trustedVerifiers.has(adapter);
}

// The production adapter. With no contract, it never reaches the network.
export const productionAdapter = createVcGatewayAdapter();
trustedVerifiers.add(productionAdapter);
