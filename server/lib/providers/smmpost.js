import { registerProviderAdapter } from '../provider.js';

// ---------------------------------------------------------------------------
// Generic "standard SMM POST API" adapter — works with the common JSON or
// form-encoded SMM API contract used by most providers:
//   POST {api_url}  body {action, key, ...}
// Actions: services | add | status | balance | cancel | refill
//
// Safety contract (never violated, even on errors):
//   - every request has a hard timeout (AbortController);
//   - api_key is sent only in the POST body, never logged/echoed;
//   - error strings are stripped of the key before they bubble up;
//   - placeOrder returns {id, status, charge?, currency?}.
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 15000;

function sanitizeError(msg, apiKey) {
  if (apiKey && msg) return String(msg).split(apiKey).join('[redacted]');
  return msg;
}

// Failures are tagged for the order lifecycle (orderLifecycle.classifyProviderFailure):
//   kind 'rejected' — the supplier answered with an explicit refusal (4xx or an
//                     {error} body below 500). Nothing was accepted.
//   kind 'unknown'  — timeout, network failure, 5xx, or a non-JSON reply. The
//                     supplier may still have accepted the order.
// The message text is sanitized and is only ever shown to admins.
function supplierError(message, kind, category) {
  return Object.assign(new Error(message), { kind, category });
}

async function fetchJSON(apiUrl, apiKey, form) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    const body = new URLSearchParams({ key: apiKey, ...form });
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } catch (e) {
    // fetch rejects on network failure / abort. Outcome unknown.
    const timedOut = ctrl.signal.aborted;
    const why = timedOut ? `Provider timed out after ${TIMEOUT_MS / 1000}s` : 'Provider unreachable';
    throw supplierError(sanitizeError(`${why}: ${e?.message || ''}`.slice(0, 240), apiKey),
      'unknown', timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw supplierError(sanitizeError(`Provider returned non-JSON (${res.status}): ${text.slice(0, 200)}`, apiKey),
      'unknown', res.status >= 500 ? 'http_5xx' : 'non_json');
  }
  if (data && data.error) {
    const msg = sanitizeError(String(data.error).slice(0, 240), apiKey);
    if (res.status >= 500) throw supplierError(msg, 'unknown', 'http_5xx');
    const funds = /balance|funds|insufficient|credit/i.test(msg);
    throw supplierError(msg, 'rejected', funds ? 'insufficient_supplier_funds' : 'provider_rejected');
  }
  if (res.status >= 500) throw supplierError(`Provider returned HTTP ${res.status}`, 'unknown', 'http_5xx');
  return data;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Locate a single order entry in the batch-status payload. Responses are
// usually keyed by the order id (object) or a list of objects carrying
// order/order_refference/order_reference — we accept all shapes.
function pickEntry(data, key) {
  if (Array.isArray(data)) {
    return data.find((e) => entryKey(e) === key);
  }
  if (data && typeof data === 'object') {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null) return data[key];
    return Object.values(data).find((e) => e && typeof e === 'object' && entryKey(e) === key);
  }
  return null;
}
function entryKey(e) {
  return String(e?.order ?? e?.id ?? e?.order_refference ?? e?.order_reference ?? '');
}

function parseServices(data) {
  const maps = Array.isArray(data) ? data : (Array.isArray(data?.services) ? data.services : null);
  if (!maps) {
    // Object keyed by id.
    return Object.entries(data || {}).map(([service, s]) => ({
      service: String(service),
      name: String(s.name ?? s.service ?? 'Service'),
      rate: toNumber(s.rate ?? s.price ?? 0) ?? 0,
      min: toNumber(s.min) ?? 1,
      max: toNumber(s.max) ?? 999999,
      category: String(s.category ?? 'Services'),
      description: String(s.description ?? ''),
      type: String(s.type ?? reflectType(s) ?? 'Default'),
      avg: avgCompletionTime(s),
      quality: qualityOf(s),
      refill: refillFlag(s),
      cancel: cancelFlag(s),
    }));
  }
  return maps.map((s) => ({
    service: String(s.service ?? s.id ?? ''),
    name: String(s.name ?? 'Service'),
    rate: toNumber(s.rate ?? s.price ?? 0) ?? 0,
    min: toNumber(s.min) ?? 1,
    max: toNumber(s.max) ?? 999999,
    category: String(s.category ?? 'Services'),
    description: String(s.description ?? s.details ?? ''),
    type: String(s.type ?? reflectType(s) ?? 'Default'),
    avg: avgCompletionTime(s),
    quality: qualityOf(s),
    refill: refillFlag(s),
    cancel: cancelFlag(s),
  }));
}

// Average completion time. Providers expose it as `avg` (a human string
// like "2-3 hours", or minutes as a number), `average_time`, `average`
// or `time`. Numeric values are minutes in the SMM POST contract.
function avgCompletionTime(s) {
  const raw = s.avg ?? s.average_time ?? s.average ?? s.time ?? s.speed ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return `${Math.round(n)} min`;
  return String(raw).trim().slice(0, 80);
}

// Optional quality tier (some suppliers tag services "High Quality",
// "BEST", a numeric tier, etc.). Stored verbatim, never invented.
function qualityOf(s) {
  const raw = s.quality ?? s.quality_label ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw).trim().slice(0, 80);
}

// Provider service lists may mark capabilities via boolean flags, "1"/"0"
// strings, or the customary "refill": true / "cancel": true keys.
function refillFlag(s) {
  const v = s.refill;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}
function cancelFlag(s) {
  const v = s.cancel;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}
function reflectType(s) {
  if (s.comments !== undefined) return 'Comments';
  if (s.runs !== undefined || s.interval !== undefined) return 'Paged';
  return null;
}

function factory(row) {
  const apiUrl = row.api_url;
  const apiKey = row.api_key;

  if (!apiUrl || !apiKey) {
    throw new Error('Provider requires api_url and api_key (set in Admin → Providers).');
  }

  return {
    kind: 'smmpost',
    name: row.name || 'SMM API',
    async listServices() {
      const data = await fetchJSON(apiUrl, apiKey, { action: 'services' });
      return parseServices(data);
    },
    async placeOrder({ service, link, quantity, extras = {} }) {
      const form = { action: 'add', service, link, quantity };
      // Provider-specific fields pass through only when the service type asks
      // for them (comments/paged). Never injected for plain services.
      for (const k of ['comments', 'runs', 'interval']) {
        const v = extras?.[k];
        if (v !== undefined && v !== null && v !== '') form[k] = v;
      }
      const data = await fetchJSON(apiUrl, apiKey, form);
      // Providers return the order as `order` or `order_refference` (SMM v2
      // spelling) or `order_reference`. Any of them is the idempotency key.
      return {
        id: String(data.order ?? data.order_refference ?? data.order_reference ?? data.id ?? ''),
        externalRef: String(data.order ?? data.order_refference ?? data.order_reference ?? data.id ?? ''),
        status: String(data.status ?? 'PENDING').toUpperCase(),
        charge: toNumber(data.charge ?? data.price ?? 0),
        currency: String(data.currency ?? row.currency ?? 'USD'),
      };
    },
    async orderStatus(id, orderRow) {
      const data = await fetchJSON(apiUrl, apiKey, { action: 'status', order: id });
      return {
        id,
        status: String(data.status ?? 'PENDING').toUpperCase(),
        startCount: toNumber(data.start_count ?? data.startCount) ?? 0,
        remains: toNumber(data.remains ?? data.remainder) ?? 0,
        charge: toNumber(data.charge ?? data.price) ?? undefined,
        currency: data.currency ? String(data.currency) : undefined,
      };
    },
    // Batch status (action=status, orders="1,2,3", ≤100 per call). Returns a
    // Map keyed by our orders row id so the ticker can apply changes directly.
    async batchStatuses(orders) {
      const result = new Map();
      const ids = orders.map((o) => o.provider_order_id || o.order_ref);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const data = await fetchJSON(apiUrl, apiKey, { action: 'status', orders: chunk.join(',') });
        for (const o of orders) {
          const key = o.provider_order_id || o.order_ref;
          const entry = pickEntry(data, key);
          if (!entry) continue;
          result.set(o.id, {
            status: String(entry.status ?? 'PENDING').toUpperCase(),
            startCount: toNumber(entry.start_count ?? entry.startCount) ?? 0,
            remains: toNumber(entry.remains ?? entry.remainder) ?? 0,
            charge: toNumber(entry.charge ?? entry.price) ?? undefined,
            currency: entry.currency ? String(entry.currency) : undefined,
          });
        }
      }
      return result;
    },
    async balance() {
      const data = await fetchJSON(apiUrl, apiKey, { action: 'balance' });
      const v = data.balance ?? data.Balance ?? data;
      const n = toNumber(v) ?? 0;
      return { balance: n, currency: String(data.currency ?? row.currency ?? 'USD') };
    },
    async cancel(id) {
      return await fetchJSON(apiUrl, apiKey, { action: 'cancel', order: id });
    },
    async refill(id) {
      return await fetchJSON(apiUrl, apiKey, { action: 'refill', order: id });
    },
  };
}

registerProviderAdapter('smmpost', factory);
export default factory;