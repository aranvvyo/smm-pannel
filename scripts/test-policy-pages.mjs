// Static checks for the Terms of Service, the Refund Policy and the links that reach them.
// Reads source text only: no server, no database, no network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const terms = read('client/src/pages/client/Terms.jsx');
const refund = read('client/src/pages/client/RefundPolicy.jsx');
const landing = read('client/src/pages/landing/Landing.jsx');
const layout = read('client/src/components/Layout.jsx');
const app = read('client/src/App.jsx');

let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};
const count = (src, needle) => src.split(needle).length - 1;

console.log('policy pages (static)');

// --- Terms of Service ---
check('Terms: stale "September 2025" date removed', !terms.includes('September 2025'));
check('Terms: no visible "Last updated" date line', !/Last updated/i.test(terms) && !/18 October 2026/.test(terms));
check('Refund Policy: no visible "Last updated" date line', !/Last updated/i.test(refund) && !/18 October 2026/.test(refund));
check('Terms and Refund Policy: no reference to a date shown on the page', !/date shown/i.test(terms + refund));
check('Terms: drop-based services section states no warranty', terms.includes('Drop-Based Services: No Warranty') && terms.includes('do not include a warranty'));
check('Terms: average drop-rate data is stated as non-warranty', terms.includes('does not create a warranty'));
check('Terms: links to the Refund Policy and Privacy Policy', terms.includes('href="/refund-policy"') && terms.includes('href="/privacy"'));
check('Terms: support points to the existing Tickets page', terms.includes('/tickets'));
check('Terms: no blanket "all services are covered" warranty wording', !/all services (are|have) (covered|warrant)/i.test(terms));
check('Terms: no "guaranteed refill" wording', !/guaranteed refill/i.test(terms));
check('Terms: the 10% incomplete-order rule is not published (only the INR surcharge 10% remains)', count(terms, '10%') === 1 && terms.includes('customer surcharge of 10%'));
check('Terms: no invented email address', !/@[a-z0-9-]+\.[a-z]{2,}/i.test(terms));
check('Terms: no blanket "no refunds" clause', !/no refunds? (under any|at all|will be)/i.test(terms));
check('Terms: no statement that funds are forfeited automatically', !/forfeit(ed)? automatically|confiscat/i.test(terms));
check('Terms: lists the three checkout crypto methods', terms.includes('Litecoin (LTC)') && terms.includes('USDT BEP20') && terms.includes('USDT ERC20'));
check('Terms: states supplier-rejected auto refund once', terms.includes('exact amount debited is returned to your wallet automatically, once'));
check('Terms: refused-order wording matches the UI label, not an unshown "rejected" status', terms.includes('"Not accepted · refunded"') && !/marked as rejected/i.test(terms));
check('Refund Policy: no unconfirmed 24h-7d processing deadline published', !/24 hours to 7 days|24 hours|7 days/i.test(refund));
check('Refund Policy: no placeholder effective date left on the page', !/to be confirmed/i.test(refund));

// --- Refund Policy ---
check('Refund Policy: supplier-rejected auto refund stated', refund.includes('exact amount debited is returned to your wallet automatically, once'));
check('Refund Policy: cancellation refund limited to supported services', refund.includes('Where we cancel an order and the service supports cancellation'));
check('Refund Policy: states failed/partial orders are not automatically refunded', refund.includes('Automatic refunds are not given for failed or partial orders'));
check('Refund Policy: no unconditional "full amount" canceled-order refund', !/canceled orders return the full amount/i.test(refund + landing));
check('Refund Policy: the page is declared exactly once', count(refund, 'export default function RefundPolicyPage') === 1);

// --- Landing FAQ (must not contradict the policies) ---
check('Landing FAQ: no claim of encrypted session cookies', !landing.includes('encrypted HttpOnly'));
check('Landing FAQ: no minutes-to-hours delivery promise', !landing.includes('within minutes to hours'));
check('Landing FAQ: no self-service cancel claim (PENDING/IN_PROGRESS)', !landing.includes('Cancel is available for PENDING'));
check('Landing FAQ: refund answer points to the Refund Policy', landing.includes('Refund, Deposit & Payment Policy'));

// --- Routing and navigation ---
check('App: /terms route registered exactly once', count(app, 'path="/terms"') === 1);
check('App: /refund-policy route registered exactly once', count(app, 'path="/refund-policy"') === 1);
check('Footer (Layout): links to Terms and the Refund Policy', layout.includes('to="/terms"') && layout.includes('to="/refund-policy"'));
check('Landing footer: links to Terms and the Refund Policy', landing.includes('to="/terms"') && landing.includes('to="/refund-policy"'));

console.log(`\npolicy pages: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
