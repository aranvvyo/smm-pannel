import { registerProviderAdapter } from '../provider.js';

// ---------------------------------------------------------------------------
// Demo provider — a pure, STATELESS simulator used ONLY by the automated test
// suite (SMM_TEST=1 server). It is NEVER registered in a normal production
// boot, so a production app can never silently fall back to fake orders,
// fake statuses or fake balances (Task 18).
// Order progression is derived deterministically from the order ref + created
// time, so in-flight orders survive server restarts. Simulated orders ramp:
//   PENDING (some seconds) → IN_PROGRESS (start count climbs) → COMPLETED
// A small deterministic fraction ends PARTIAL instead. Cancel/refill are
// admin-driven and only succeed for services that advertise them.
//
// Failure injection: in test mode a request whose link contains "fail" makes
// placeOrder throw, so the suite can prove "provider error ⇒ no debit, no
// order, error surfaced" without touching a real API.
// ---------------------------------------------------------------------------

const TEST_MODE = process.env.SMM_TEST === '1';

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Simulated routing latency (seconds) for a given order ref.
// DEMO_SPEED scales the whole curve (default 1x). Tests set DEMO_SPEED=2 to
// fast-forward PENDING/IN_PROGRESS so smoke tests can observe transitions
// without waiting minutes. Read lazily so the value can be set at boot.
function delays(ref) {
  const seed = hashSeed(ref);
  const speed = Number(process.env.DEMO_SPEED) || 1;
  const pending = (20 + (seed % 6) * 12) / speed;   // 20-80s PENDING / speed
  const progress = (90 + (seed % 7) * 30) / speed;  // 90-270s IN_PROGRESS ramp / speed
  const isPartial = seed % 29 === 0;                // ~3.5% end as PARTIAL
  return { pending, progress, isPartial };
}

/**
 * Compute what the order SHOULD look like right now.
 * @param {object} o  {order_ref, quantity, status, start_count, created_at}
 * @returns {{status, startCount, remains, changed}}
 */
export function demoAdvance(o) {
  const { pending, progress, isPartial } = delays(o.order_ref);
  const t = (Date.now() - o.created_at) / 1000;

  if (o.status === 'CANCELED' || o.status === 'COMPLETED' || o.status === 'PARTIAL') {
    return {
      status: o.status,
      startCount: o.status === 'COMPLETED' ? o.quantity : o.start_count,
      remains: o.status === 'COMPLETED' ? 0 : Math.max(0, o.quantity - o.start_count),
      changed: false,
    };
  }

  let status, startCount, remains, changed = false;
  if (t < pending) {
    status = 'PENDING';
    startCount = 0;
    remains = o.quantity;
  } else if (t < pending + progress) {
    status = 'IN_PROGRESS';
    const frac = (t - pending) / progress;
    startCount = Math.min(o.quantity, Math.ceil(o.quantity * (0.06 + frac * 0.94)));
    remains = Math.max(0, o.quantity - startCount);
  } else {
    if (isPartial) {
      status = 'PARTIAL';
      startCount = Math.round(o.quantity * 0.96);
    } else {
      status = 'COMPLETED';
      startCount = o.quantity;
    }
    remains = Math.max(0, o.quantity - startCount);
  }
  changed =
    status !== o.status ||
    (startCount !== o.start_count) ||
    (remains !== o.remains);
  return { status, startCount, remains, changed };
}

// Build a fake deterministic "provider order id" so refills/cancels feel real.
export function fakeProviderId(orderRef, serviceRef) {
  return `D-${hashSeed(orderRef + ':' + serviceRef).toString(36).toUpperCase()}${Date.now().toString(36).slice(-4)}`;
}

// Whether this environment may expose the test-only demo adapter at all.
export function demoEnabled() {
  return TEST_MODE;
}

function factory() {
  return {
    kind: 'demo',
    name: 'Demo',
    async listServices() {
      return [];
    },
    async placeOrder({ service, link, quantity }) {
      // Failure injection for the test suite: "provider error doesn't debit".
      if (TEST_MODE && typeof link === 'string' && link.includes('fail')) {
        throw new Error('Provider rejected the order (simulated upstream failure).');
      }
      const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`;
      return { id: fakeProviderId(orderRef, String(service)), externalRef: orderRef, status: 'PENDING' };
    },
    async orderStatus(id, orderRow) {
      // Derive demo progression from the REAL order row.
      if (orderRow) {
        const next = demoAdvance(orderRow);
        return {
          id,
          status: next.status,
          startCount: next.startCount,
          remains: next.remains,
          charge: orderRow.quantity > 0 ? orderRow.price_inr / 100 / (orderRow.quantity / 1000) : undefined,
          currency: 'INR',
        };
      }
      return { id, status: 'PENDING', startCount: 0, remains: 0 };
    },
    async balance() {
      return { balance: 100000.0, currency: 'USD' };
    },
    async cancel() { return { status: 'CANCELED' }; },
    async refill() { return { status: 'IN_PROGRESS' }; },
  };
}

// Register ONLY under SMM_TEST so a production boot has no demo adapter and no
// fake-provider path anywhere. index.js imports this file unconditionally; the
// registration here is the single gate.
if (TEST_MODE) {
  registerProviderAdapter('demo', factory);
}
export default factory;