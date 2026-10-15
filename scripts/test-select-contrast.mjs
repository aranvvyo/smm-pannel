// Dropdown (native <select>/<option>) contrast contract for the dark theme.
// Reads client/src/styles/global.css and checks the rules that fix the
// near-white-on-white category/service list. Pure Node, no browser, no network.
//   run: node scripts/test-select-contrast.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(ROOT, 'client', 'src', 'styles', 'global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');   // drop comments before matching

const results = [];
function t(name, fn) {
  try { fn(); results.push('PASS'); console.log(`  PASS  ${name}`); }
  catch (e) { results.push('FAIL'); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
// Collects the declarations of every rule whose selector list contains `selector`.
function block(selector) {
  const want = selector.replace(/\s+/g, ' ').trim();
  const re = /([^{}]+)\{([^}]*)\}/g;
  let out = '', m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((x) => x.replace(/\s+/g, ' ').trim());
    if (sels.includes(want)) out += m[2] + ';';
  }
  return out;
}
function decl(text, prop) {
  const re = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`, 'g');
  let v = null, m;
  while ((m = re.exec(text + ';'))) v = m[1].trim();
  return v;
}
function hex(h) {
  const n = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const root = block(':root');
const tok = (name) => {
  const v = decl(root, `--${name}`);
  assert.ok(v && /^#[0-9a-f]{6}$/i.test(v), `token --${name} must be a 6-digit hex (got ${v})`);
  return v;
};

console.log('Dropdown contrast tests (dark theme)\n');

t(':root declares color-scheme: dark so native lists use the dark scheme', () => {
  assert.strictEqual(decl(root, 'color-scheme'), 'dark');
});

t('select sets readable text and dark background from theme tokens', () => {
  const sel = block('select');
  assert.strictEqual(decl(sel, 'color'), 'var(--text)');
  assert.strictEqual(decl(sel, 'background-color'), 'var(--bg-elev)');
  assert.strictEqual(decl(sel, 'color-scheme'), 'dark');
});

t('option has a dark background and light text (not inherited near-white on white)', () => {
  const opt = block('select option');
  assert.strictEqual(decl(opt, 'background-color'), 'var(--surface)');
  assert.strictEqual(decl(opt, 'color'), 'var(--text)');
});

t('option text meets WCAG AA (4.5:1) on the option background', () => {
  const r = ratio(hex(tok('text')), hex(tok('surface')));
  assert.ok(r >= 4.5, `ratio ${r.toFixed(2)}`);
});

t('selected option (green tint over the surface) keeps text at 4.5:1 or better', () => {
  const surf = hex(tok('surface'));
  const acc = [16, 185, 129].map((c) => c / 255);
  const a = 0.28;
  const blended = surf.map((s, i) => acc[i] * a + s * (1 - a));
  const r = ratio(hex(tok('text')), blended);
  assert.ok(r >= 4.5, `ratio ${r.toFixed(2)}`);
  assert.match(block('select option:checked'), /background-color:\s*rgba\(16,\s*185,\s*129,\s*0\.28\)/);
});

t('disabled option and select use the muted token and show a disabled state', () => {
  assert.match(block('select option:disabled'), /color:\s*var\(--faint\)/);
  const dis = block('select:disabled');
  assert.match(dis, /color:\s*var\(--faint\)/);
  assert.match(dis, /cursor:\s*not-allowed/);
  // Disabled controls are exempt from WCAG contrast; this only records the value.
  console.log(`        info: disabled text ratio ${ratio(hex(tok('faint')), hex(tok('surface'))).toFixed(2)}:1 (exempt)`);
});

t('the category shell keeps its transparent inner select (shell owns the background)', () => {
  assert.strictEqual(decl(block('.select-shell-input'), 'background'), 'none');
});

t('no option rule uses a light background', () => {
  const opt = block('select option');
  const bg = decl(opt, 'background-color');
  assert.ok(!/#f|#e|white/i.test(bg || ''), `option background looks light: ${bg}`);
});

const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
