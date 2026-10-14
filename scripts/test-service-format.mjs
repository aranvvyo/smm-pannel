// Display-only service/category text cleanup. Pure functions, no network, no DB.
//   run: node scripts/test-service-format.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'serviceFormat.js')).href);
const { cleanDisplayText, serviceOptionLabel, serviceIdLabel } = F;

const results = [];
function t(name, fn) {
  try { fn(); results.push('PASS'); console.log(`  PASS  ${name}`); }
  catch (e) { results.push('FAIL'); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('Service text formatting tests\n');

t('collapses repeated spaces, tabs and newlines; trims', () => {
  assert.strictEqual(cleanDisplayText('  Instagram \t Followers \n [Real]  '), 'Instagram Followers [Real]');
});
t('non-breaking and typographic spaces become ordinary spaces', () => {
  assert.strictEqual(cleanDisplayText('Likes  Fast　Start'), 'Likes Fast Start');
});
t('zero-width characters and control characters are removed', () => {
  assert.strictEqual(cleanDisplayText('Ab​c﻿d⁠e'), 'Ab c d e'.replace(/ /g, ''));
  assert.strictEqual(cleanDisplayText('a\u0007b\u0000c'), 'a b c');
});
t('Unicode is normalised to NFC (e + combining accent becomes é)', () => {
  assert.strictEqual(cleanDisplayText('café'), 'café');
});
t('digits, currency symbols, punctuation and wording are not changed', () => {
  const s = '1,000 Likes (Fast) - ₹9.50 / 1K & more!';
  assert.strictEqual(cleanDisplayText(s), s);
});
t('emoji ZWJ sequences are kept intact', () => {
  const family = '👨‍👩‍👧';
  assert.strictEqual(cleanDisplayText(family), family);
});
t('null and undefined become an empty string', () => {
  assert.strictEqual(cleanDisplayText(null), '');
  assert.strictEqual(cleanDisplayText(undefined), '');
});
t('option label keeps the supplier service id and cleans the name', () => {
  const svc = { id: 7, provider_service_id: '1234', name: '  Instagram  Followers  ' };
  assert.strictEqual(serviceOptionLabel(svc), '#1234 · Instagram Followers');
  assert.strictEqual(serviceIdLabel(svc), '#1234');
});
t('option label falls back to the internal id when no supplier id exists', () => {
  assert.strictEqual(serviceOptionLabel({ id: 9, provider_service_id: null, name: 'X' }), '#9 · X');
});
t('long names are still cut to one line', () => {
  const label = serviceOptionLabel({ id: 1, provider_service_id: '1', name: 'a'.repeat(200) }, 20);
  assert.ok(label.endsWith('…'));
  assert.ok(label.length <= '#1 · '.length + 20);
});
t('input object is not mutated', () => {
  const svc = { id: 2, provider_service_id: '5', name: ' A  B ' };
  serviceOptionLabel(svc);
  assert.strictEqual(svc.name, ' A  B ');
});

const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
