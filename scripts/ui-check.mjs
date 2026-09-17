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

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);