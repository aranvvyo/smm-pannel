// quoteFlow — the New Order quote request flow.
//
// This is a deliberate test seam: it is plain JS with NO React
// or DOM imports, so the exact request protocol the browser
// runs (OrderPage delegates to it) can also be executed in Node
// by scripts/test-quote-race.mjs with deterministic, out-of-
// order async — no jsdom/@testing-library needed.
//
// Protocol: every request claims a monotonically increasing id.
// A response, error or loading-state update from a request that
// is no longer the newest is ignored ENTIRELY — an older
// in-flight request can never overwrite a newer request's
// quote, surface a stale error, or clear the loading state
// while a newer request is still pending.

export function createQuoteFlow({ fetchQuote, emit }) {
  let reqId = 0;
  let quote = null;
  let busy = false;
  let error = '';

  const snapshot = () => ({ quote, busy, error });
  const push = () => emit(snapshot());

  async function request(input) {
    const serviceId = Number(input?.serviceId);
    const quantity = Number(input?.quantity);
    // Invalid inputs never start a request or touch state.
    if (!input?.serviceId || !Number.isFinite(serviceId) || serviceId <= 0
      || !Number.isFinite(quantity) || quantity <= 0) return;

    // Claim the next request id.
    const id = ++reqId;
    busy = true;
    error = '';
    push();
    try {
      const q = await fetchQuote({ serviceId, quantity, couponCode: input.couponCode ?? null });
      // Outdated response: a newer request was already made —
      // ignore it entirely, state included.
      if (id !== reqId) return;
      // Tag the quote with the exact inputs it was computed
      // for so it can only ever display for those values.
      quote = { ...q, serviceId, quantity, coupon: input.couponCode ?? null };
      push();
    } catch (x) {
      // Outdated error: never overwrite the current state.
      if (id !== reqId) return;
      quote = null;
      error = x?.message || 'Quote request failed.';
      push();
    } finally {
      // Only the newest request may clear the loading state.
      if (id === reqId) {
        busy = false;
        push();
      }
    }
  }

  // Inputs changed: drop the displayed quote, stop waiting on
  // any in-flight request and clear its stale error. The
  // abandoned response is ignored when it eventually arrives.
  function invalidate() {
    reqId++;
    quote = null;
    error = '';
    busy = false;
    push();
  }

  return { request, invalidate, snapshot };
}
