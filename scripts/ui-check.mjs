// UI-invariant checks — verify client source guarantees that are not reachable
// over HTTP (redirect targets, mobile-menu overflow, landing honesty).
// Usage: node scripts/ui-check.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let ok = 0, fail = 0;
const check = (name, pass, extra = '') => {
  if (pass) ok++; else fail++;
  console.log(`${pass ? 'ok' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// --- Navigation: a signed-in / new client must land on Dashboard, never Support
for (const [name, file, needle] of [
  ['login redirects to /dashboard', 'client/src/pages/auth/Login.jsx', "nav(admin || user?.role === 'admin' ? '/admin' : '/dashboard')"],
  ['signup redirects to /dashboard', 'client/src/pages/auth/Signup.jsx', "nav('/dashboard')"],
  ['PublicOnly sends logged-in clients to dashboard', 'client/src/App.jsx', "user.role === 'admin' ? '/admin' : '/dashboard'"],
]) {
  if (!existsSync(path.join(root, file))) { check(name, false, 'missing ' + file); continue; }
  check(name, read(file).includes(needle), file);
}

// --- Deposit page honesty & conversion
const deposit = read('client/src/pages/client/Deposit.jsx');
check('deposit page uses unit-aware rate label (fmtRateINR)', deposit.includes('fmtRateINR(rate)'));
check('deposit page preview mirrors cents×rate math', /Math\.round\(Number\(amountUsd\) \* 100\) \* rate/.test(deposit));
check('no legacy ₹1.00-per-1USD label (fmtInr(rate))', !deposit.includes('fmtInr(rate)'));
check('pending invoice is never labeled confirmed', deposit.includes('Waiting for payment'));
const ui = read('client/src/ui.jsx');
check('fmtRateINR helper exists', /export const fmtRateINR/.test(ui));

// --- Mobile menu must scroll internally (never clip the logout item)
const css = read('client/src/styles/global.css');
check('mobile menu uses viewport-height max + internal scroll',
  /\.mobile-menu\.open\s*\{[^}]*overflow-y\s*:\s*auto[^}]*\}/s.test(css) &&
  /\.mobile-menu\.open\s*\{[^}]*max-height:\s*min\(calc\(100dvh/.test(css));
check('no legacy fixed 500px mobile-menu cap', !/\.mobile-menu\.open\s*\{[^}]*max-height:\s*500px/.test(css));
check('small screens can never overflow horizontally',
  /input, select, textarea, button \s*\{\s*max-width:\s*100%;/.test(css));

// --- Landing must not fabricate stats
const landing = read('client/src/pages/landing/Landing.jsx');
const fake = /200\s*k|9\.9\/10|satisfied clients|rated 9/i;
check('landing has no fabricated claim text', !fake.test(landing));
check('landing CTA for clients goes to dashboard', /cta = user \? \(user\.role === 'admin' \? '\/admin' : '\/dashboard'\) : '\/signup'/.test(landing));

// --- New Order: compact category dropdown (not a long chip list)
const orderPage = read('client/src/pages/client/OrderPage.jsx');
check('new order uses a compact category dropdown (select), not a chip list',
  orderPage.includes('id="cat-select"') && !orderPage.includes('cat-chips'));
check('category dropdown keeps the "All categories" option',
  /<option value="">All categories/.test(orderPage));

// --- Anime 3D hero: code-split, fallback-safe, configurable model path
const heroScene = read('client/src/components/HeroScene.jsx');
check('landing lazy-loads the 3D hero (code-split)',
  /lazy\(\(\) => import\('\.\.\/\.\.\/components\/HeroScene\.jsx'\)\)/.test(landing));
check('hero scene degrades without WebGL', heroScene.includes('webglAvailable'));
check('hero 3D effects are user-disableable', heroScene.includes('Disable 3D'));
check('hero model path is configurable (VITE_HERO_MODEL_URL)',
  heroScene.includes('VITE_HERO_MODEL_URL'));

// --- New Order form: category/service state correctness
check('new order distinguishes loading from provider-unconfigured',
  orderPage.includes('providerConfigured === null'));
check('new order keeps a service that is still valid for the new category',
  orderPage.includes('stillValid'));
check('new order clears a quantity that is stale for the selected service',
  orderPage.includes('stale for the newly selected service'));

// --- New Order: stale-quote race guards.
// The quote request protocol lives in client/src/lib/quoteFlow.js
// — plain JS shared by the page and scripts/test-quote-race.mjs,
// which EXECUTES the out-of-order request race. These checks
// only verify the page delegates to it and keeps the display
// guards; the ordering itself is covered by the async test.
const quoteFlowSrc = read('client/src/lib/quoteFlow.js');
check('new order page delegates its quote flow to the shared module',
  orderPage.includes('createQuoteFlow')
  && orderPage.includes('quoteFlow.request'));
check('quote flow serializes requests with a monotonic request id',
  quoteFlowSrc.includes('const id = ++reqId;'));
check('quote flow ignores outdated responses, errors and loading updates',
  (quoteFlowSrc.match(/if \(id !== reqId\) return;/g) || []).length >= 2
  && quoteFlowSrc.includes('if (id === reqId) {'));
check('quote flow tags every quote with the exact inputs it was computed for',
  quoteFlowSrc.includes('quote = { ...q, serviceId, quantity, coupon: input.couponCode ?? null };'));
check('quote flow abandons in-flight requests when inputs change',
  quoteFlowSrc.includes('function invalidate()')
  && /reqId\+\+;/.test(quoteFlowSrc));
check('new order displays a quote only when its key matches the current form values',
  orderPage.includes('quote.serviceId === Number(serviceId)')
  && orderPage.includes('quote.quantity === quantity')
  && orderPage.includes('quote.coupon === couponCode'));
check('new order disables Place while a quote is pending, unmatched, or the quantity is out of range',
  /disabled=\{[^}]*quoteBusy/.test(orderPage)
  && /disabled=\{[^}]*!quoteMatches/.test(orderPage)
  && /disabled=\{[^}]*!qtyInRange/.test(orderPage));
check('new order place() rejects a missing or stale quote before any provider call',
  orderPage.includes('if (!quoteMatches || !qtyInRange) {'));
check('new order refuses a duplicate submission while one is in flight',
  orderPage.includes('if (inFlight.current) return;'));

// --- Landing data integrity + honest security copy
const publicSrc = read('server/routes/public.js');
check('landing services payload carries a stable row id (SQL projection + response map)',
  publicSrc.includes('SELECT s.id, s.name') && publicSrc.includes('id: s.id,'));
check('landing service tiles key by id (never by name)', landing.includes('key={s.id}'));
check('landing webhook copy matches the implementation (token check + server verify)',
  landing.includes('token-checked') && landing.includes('server-verified'));

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);