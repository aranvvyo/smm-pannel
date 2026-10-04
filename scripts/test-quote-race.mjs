// ---------------------------------------------------------------------------
// Asynchronous regression test — the New Order quote-request race.
//
// OrderPage delegates its quote flow to client/src/lib/quoteFlow.js
// (plain JS, no React/DOM imports), so the exact protocol the
// browser runs is executed here with deterministic, out-of-order
// async via manually-resolved deferred promises.
//
// Covers:
//   1. two requests for different inputs, the NEWER resolving
//      first and the OLDER afterward — the older response must
//      not overwrite the newer quote;
//   2. an older request settling while a newer one is still
//      pending — its "finally" must not clear the loading state;
//   3. an older request FAILING after the newer succeeded — the
//      stale error must not surface or clear the newer quote;
//   4. input changes while a request is pending (invalidate);
//   5. input-key tagging, newest-request error surfacing, and
//      invalid-input short-circuiting.
//
// Usage: node scripts/test-quote-race.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert';
import { createQuoteFlow } from '../client/src/lib/quoteFlow.js';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e && e.message ? e.message : String(e)}`);
  }
}

// A promise the test resolves/rejects manually, so quote
// responses can arrive in any order.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const Q = (final) => ({ ok: true, price: final, discount: 0, final });

await t('out-of-order responses: an older quote response cannot overwrite a newer one', async () => {
  const older = deferred(); // request A: quantity 100
  const newer = deferred(); // request B: quantity 50
  const flow = createQuoteFlow({
    fetchQuote: ({ quantity }) => (quantity === 100 ? older.promise : newer.promise),
    emit: () => {},
  });

  const pA = flow.request({ serviceId: 7, quantity: 100, couponCode: null });
  assert.strictEqual(flow.snapshot().busy, true, 'loading state must be set while a request is pending');
  const pB = flow.request({ serviceId: 7, quantity: 50, couponCode: null });

  // The NEWER request resolves first.
  newer.resolve(Q(500));
  await pB;
  assert.strictEqual(flow.snapshot().quote.quantity, 50, 'the newer quote is the displayed one');
  assert.strictEqual(flow.snapshot().busy, false, 'loading clears when the newest request settles');

  // The OLDER request resolves afterward — it must be ignored entirely.
  older.resolve(Q(9999));
  await pA;
  const s = flow.snapshot();
  assert.strictEqual(s.quote.quantity, 50, 'the older response must not replace the newer quote');
  assert.strictEqual(s.quote.final, 500, 'the older price must not leak into the displayed quote');
  assert.strictEqual(s.busy, false, 'the older request must not touch the loading state');
});

await t('an older request settling cannot clear the loading state while a newer request is pending', async () => {
  const older = deferred();
  const newer = deferred();
  const flow = createQuoteFlow({
    fetchQuote: ({ quantity }) => (quantity === 100 ? older.promise : newer.promise),
    emit: () => {},
  });

  const pA = flow.request({ serviceId: 7, quantity: 100, couponCode: null });
  const pB = flow.request({ serviceId: 7, quantity: 50, couponCode: null });

  // The older request settles while the newer one is still in flight.
  older.resolve(Q(1));
  await pA;
  assert.strictEqual(flow.snapshot().busy, true, 'loading must stay set — the newer request is still pending');
  assert.strictEqual(flow.snapshot().quote, null, 'no quote may display before the newest request settles');

  newer.resolve(Q(2));
  await pB;
  assert.strictEqual(flow.snapshot().busy, false);
  assert.strictEqual(flow.snapshot().quote.final, 2);
});

await t('an older request failing cannot clear the newer quote or surface a stale error', async () => {
  const older = deferred();
  const newer = deferred();
  const flow = createQuoteFlow({
    fetchQuote: ({ quantity }) => (quantity === 100 ? older.promise : newer.promise),
    emit: () => {},
  });

  const pA = flow.request({ serviceId: 7, quantity: 100, couponCode: null });
  const pB = flow.request({ serviceId: 7, quantity: 50, couponCode: null });

  // The newer request succeeds first, then the older one fails.
  newer.resolve(Q(20));
  await pB;
  older.reject(new Error('stale upstream failure'));
  await pA;
  const s = flow.snapshot();
  assert.strictEqual(s.quote.final, 20, 'the older failure must not clear the newer quote');
  assert.strictEqual(s.error, '', 'the older error must not surface');
  assert.strictEqual(s.busy, false);
});

await t('the newest request failure clears the quote and surfaces its error', async () => {
  const flow = createQuoteFlow({
    fetchQuote: async () => { throw new Error('provider down'); },
    emit: () => {},
  });
  await flow.request({ serviceId: 7, quantity: 50, couponCode: null });
  const s = flow.snapshot();
  assert.strictEqual(s.quote, null, 'a failed quote must not display');
  assert.strictEqual(s.error, 'provider down');
  assert.strictEqual(s.busy, false, 'loading must clear after a failure');
});

await t('a successful quote is tagged with the exact inputs it was computed for', async () => {
  const flow = createQuoteFlow({
    fetchQuote: async ({ serviceId, quantity, couponCode }) => Q(quantity * 10),
    emit: () => {},
  });
  await flow.request({ serviceId: 42, quantity: 250, couponCode: 'WELCOME10' });
  const q = flow.snapshot().quote;
  assert.strictEqual(q.serviceId, 42);
  assert.strictEqual(q.quantity, 250);
  assert.strictEqual(q.coupon, 'WELCOME10', 'the normalized coupon code is part of the quote key');
});

await t('input changes while a request is pending: invalidate() drops the quote and abandons the request', async () => {
  const pending = deferred();
  const states = [];
  const flow = createQuoteFlow({
    fetchQuote: () => pending.promise,
    emit: (s) => states.push({ ...s, quote: s.quote ? { ...s.quote } : null }),
  });

  const p = flow.request({ serviceId: 7, quantity: 50, couponCode: null });
  assert.strictEqual(flow.snapshot().busy, true);

  // The user changes the form inputs before the response arrives.
  flow.invalidate();
  assert.strictEqual(flow.snapshot().quote, null, 'the stale quote is dropped immediately');
  assert.strictEqual(flow.snapshot().busy, false, 'loading stops — the abandoned request is no longer waited on');

  // The abandoned response arrives later — it must be ignored.
  pending.resolve(Q(777));
  await p;
  const s = flow.snapshot();
  assert.strictEqual(s.quote, null, 'the abandoned response must not be stored');
  assert.strictEqual(s.busy, false, 'the abandoned request must not re-set the loading state');
  assert.ok(states.length >= 2, 'state changes must be emitted for the UI');
});

await t('invalid inputs never start a request or set the loading state', async () => {
  let calls = 0;
  const flow = createQuoteFlow({
    fetchQuote: async () => { calls++; return Q(1); },
    emit: () => {},
  });
  await flow.request({ serviceId: '', quantity: 0, couponCode: null });
  await flow.request({ serviceId: 7, quantity: -5, couponCode: null });
  await flow.request({ serviceId: 7, quantity: 'abc', couponCode: null });
  await flow.request(null);
  assert.strictEqual(calls, 0, 'no quote request may be sent for invalid inputs');
  assert.strictEqual(flow.snapshot().busy, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
