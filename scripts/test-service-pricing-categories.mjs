// Focused regression tests for: zero/near-zero price handling, category
// de-duplication and icons, service ID search, and custom-comment orders.
// Pure modules only (no express, no pg, no database) so it runs anywhere Node runs.
import assert from 'node:assert/strict';
import { normalizeRate, applyMarkup, priceFor } from '../server/lib/money.js';
import { assessServicePrice, isCustomerVisible, REVIEW_RATE_RUPEES } from '../server/lib/servicePrice.js';
import { validateCommentOrder, normalizeCommentLines } from '../server/lib/commentOrder.js';
import { canonicalizeCategories, categoryKey } from '../server/lib/providerSync.js';
import { fmtRatePer1k, platformEmoji, platformOf, serviceIdLabel, serviceOptionLabel, groupCategoriesByPlatform } from '../client/src/lib/serviceFormat.js';
import { filterServices } from '../client/src/lib/serviceSearch.js';
import { commentLines, commentProblem } from '../client/src/lib/commentLines.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
}

console.log('Zero and near-zero prices');
t('a sub-paisa positive rate stays positive in storage (not rounded to 0)', () => {
  assert.ok(normalizeRate(0.00004) > 0);
  assert.strictEqual(normalizeRate(0.00004), 0.00004);
  assert.ok(applyMarkup(0.00004, 'percent', 25) > 0);
});
t('float drift is still removed (0.1 + 0.2 stores as 0.3)', () => {
  assert.strictEqual(normalizeRate(0.1 + 0.2), 0.3);
});
t('a legitimate fractional rate keeps its exact value (₹0.45 per 1000)', () => {
  assert.strictEqual(normalizeRate(0.45), 0.45);
  assert.strictEqual(priceFor(1000, 0.45), 45);
});
t('zero, negative and missing rates are INVALID and never customer-visible', () => {
  for (const rate of [0, -1, NaN, undefined, null]) {
    const a = assessServicePrice({ admin_rate: rate, provider_rate: rate, min: 10 });
    assert.strictEqual(a.status, 'invalid', `rate ${rate}`);
    assert.strictEqual(isCustomerVisible({ admin_rate: rate, provider_rate: rate, min: 10 }), false);
  }
});
t('a positive rate that rounds to ₹0.00 at the minimum is UNORDERABLE and hidden', () => {
  const s = { admin_rate: 0.00004, provider_rate: 0.00004, min: 10 };
  assert.strictEqual(assessServicePrice(s).status, 'unorderable');
  assert.strictEqual(isCustomerVisible(s), false);
});
t('an ordinary positive price is OK and visible', () => {
  const s = { admin_rate: 50, provider_rate: 40, min: 100 };
  assert.strictEqual(assessServicePrice(s).status, 'ok');
  assert.strictEqual(isCustomerVisible(s), true);
});
t('an unusually low but positive price is flagged for REVIEW and stays visible', () => {
  const s = { admin_rate: 0.005, provider_rate: 0.005, min: 1000 };
  assert.strictEqual(assessServicePrice(s).status, 'review');
  assert.ok(0.005 < REVIEW_RATE_RUPEES);
  assert.strictEqual(isCustomerVisible(s), true);
});
t('"no profit" accounts are judged on the provider rate, not the selling rate', () => {
  const s = { admin_rate: 0, provider_rate: 12, min: 10 };
  assert.strictEqual(assessServicePrice(s, { noProfit: false }).status, 'invalid');
  assert.strictEqual(assessServicePrice(s, { noProfit: true }).status, 'ok');
});
t('a positive price is never displayed as ₹0 (sub-paisa shows its real value)', () => {
  assert.strictEqual(fmtRatePer1k(0.00004), '₹0.00004');
  assert.notStrictEqual(fmtRatePer1k(0.00004), '₹0');
  assert.strictEqual(fmtRatePer1k(0), 'No price');
  assert.strictEqual(fmtRatePer1k(0.45), '₹0.45');
  assert.strictEqual(fmtRatePer1k(12.5), '₹12.50');
});

console.log('Categories');
t('categories that differ only by case or whitespace merge into one', () => {
  const cats = [
    { id: 2, name: 'Instagram  Views', slug: 'srvc-9', sort: 0 },
    { id: 7, name: 'instagram views', slug: 'cat-instagram-views-aaaaaaaa', sort: 0 },
    { id: 9, name: ' Instagram Views ', slug: 'srvc-11', sort: 0 },
  ];
  const { canonical, canonicalOf } = canonicalizeCategories(cats);
  assert.strictEqual(canonical.length, 1);
  assert.strictEqual(canonical[0].id, 7, 'the canonical cat-* row wins');
  assert.strictEqual(canonicalOf.get(2).id, 7);
  assert.strictEqual(canonicalOf.get(9).id, 7);
});
t('genuinely different categories are never merged', () => {
  const cats = [{ id: 1, name: 'Instagram Views' }, { id: 2, name: 'Instagram Likes' }];
  assert.strictEqual(canonicalizeCategories(cats).canonical.length, 2);
});
t('sync derives the same category slug for case and whitespace variants', () => {
  assert.strictEqual(categoryKey('Instagram  Views'), categoryKey('instagram views'));
  assert.notStrictEqual(categoryKey('Instagram Views'), categoryKey('Instagram Likes'));
});
t('platform icons: Instagram, YouTube, TikTok, X, Facebook', () => {
  assert.strictEqual(platformEmoji('Instagram Views'), '📸');
  assert.strictEqual(platformEmoji('YouTube Watch Time'), '▶️');
  assert.strictEqual(platformEmoji('TikTok Likes'), '🎵');
  assert.strictEqual(platformEmoji('Tik Tok Followers'), '🎵');
  assert.strictEqual(platformEmoji('X (Twitter) Followers'), '𝕏');
  assert.strictEqual(platformEmoji('Facebook Page Likes'), '📘');
  // Telegram now has its own platform group (✈️). Updated when the platform list was added.
  assert.strictEqual(platformEmoji('Telegram Members'), '✈️');
  assert.strictEqual(platformEmoji('Random Gadgets'), '', 'no icon for unrelated platforms');
});

console.log('Service ID search');
const CATALOG = [
  { id: 11, provider_service_id: 1234, name: 'Instagram Followers Premium', description: '', category_name: 'Instagram', type: 'Default' },
  { id: 12, provider_service_id: 99, name: 'Instagram Views 1234 bonus', description: '', category_name: 'Instagram', type: 'Default' },
  { id: 13, provider_service_id: 555, name: 'YouTube Views', description: 'fast', category_name: 'YouTube', type: 'Default' },
];
t('an exact provider ID finds that service first', () => {
  const r = filterServices(CATALOG, '1234');
  assert.strictEqual(r[0].id, 11);
});
t('a "#" prefix also matches the ID', () => {
  assert.strictEqual(filterServices(CATALOG, '#555')[0].id, 13);
});
t('an exact ID ranks above a keyword hit that merely contains the digits', () => {
  const r = filterServices(CATALOG, '1234');
  assert.strictEqual(r[0].id, 11);
  assert.ok(r.some((s) => s.id === 12), 'keyword hit still included, just lower');
});
t('keywords must all match (AND across words), case-insensitive', () => {
  const r = filterServices(CATALOG, 'instagram PREMIUM');
  assert.deepStrictEqual(r.map((s) => s.id), [11]);
});
t('an empty query returns every service unchanged', () => {
  assert.strictEqual(filterServices(CATALOG, '   '), CATALOG);
});
t('the displayed ID label uses the provider ID when present', () => {
  assert.strictEqual(serviceIdLabel(CATALOG[0]), '#1234');
  assert.strictEqual(serviceIdLabel({ id: 42, provider_service_id: null }), '#42');
});

console.log('Custom comments');
t('non-comment services take no comments (text is null, no error)', () => {
  const r = validateCommentOrder({ serviceType: 'Default', quantity: 5, comments: 'ignored' });
  assert.deepStrictEqual(r, { ok: true, text: null });
});
t('a comment service needs at least one comment', () => {
  const r = validateCommentOrder({ serviceType: 'Comments', quantity: 2, comments: '   \n  \n' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_COMMENTS');
});
t('quantity must equal the number of comment lines', () => {
  const r = validateCommentOrder({ serviceType: 'Comments', quantity: 3, comments: 'a\nb' });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /2 comment\(s\) for a quantity of 3/);
});
t('valid comments are trimmed, blank lines dropped, CRLF handled, joined by \\n', () => {
  const r = validateCommentOrder({ serviceType: 'Comments', quantity: 2, comments: '  Nice!  \r\n\r\nGreat post \n' });
  assert.deepStrictEqual(r, { ok: true, text: 'Nice!\nGreat post' });
});
t('a single comment longer than the limit is refused', () => {
  const r = validateCommentOrder({ serviceType: 'Comments', quantity: 1, comments: 'x'.repeat(501) });
  assert.strictEqual(r.ok, false);
});
t('client validation agrees with the server on the same inputs', () => {
  const cases = [
    ['Nice!\nGreat', 2], ['Nice!\nGreat', 3], ['   ', 1], ['a\n\nb', 2], ['x'.repeat(501), 1],
  ];
  for (const [text, qty] of cases) {
    const server = validateCommentOrder({ serviceType: 'Comments', quantity: qty, comments: text });
    const client = commentProblem(text, qty);
    assert.strictEqual(server.ok, client === null, `disagree on ${JSON.stringify(text).slice(0, 20)} qty ${qty}`);
  }
  assert.deepStrictEqual(normalizeCommentLines(' a \n\n b '), commentLines(' a \n\n b '));
});

console.log('Platform groups and option labels');
t('platform keys: Instagram, YouTube, Telegram, X, Facebook, TikTok and other', () => {
  assert.strictEqual(platformOf('Instagram Comments New'), 'instagram');
  assert.strictEqual(platformOf('YouTube Watch Time'), 'youtube');
  assert.strictEqual(platformOf('Telegram Members'), 'telegram');
  assert.strictEqual(platformOf('X (Twitter) Followers'), 'x');
  assert.strictEqual(platformOf('X Followers'), 'x');
  assert.strictEqual(platformOf('Facebook Post Likes'), 'facebook');
  assert.strictEqual(platformOf('TikTok Likes'), 'tiktok');
  assert.strictEqual(platformOf('Random Gadgets'), 'other');
});
t('a standalone "x" inside other text does not tag a category as X', () => {
  assert.strictEqual(platformOf('Likes x 2 bonus'), 'other');
  assert.strictEqual(platformOf('Views x10'), 'other');
});
t('Instagram categories are never placed in the Facebook or YouTube groups', () => {
  const groups = groupCategoriesByPlatform([
    { id: 1, name: 'Facebook Post Likes', services: [{ id: 1 }] },
    { id: 2, name: 'Instagram Comments New', services: [{ id: 2 }] },
    { id: 3, name: 'YouTube Views', services: [{ id: 3 }] },
  ]);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.categories.map((c) => c.id)]));
  assert.deepStrictEqual(byKey.facebook, [1]);
  assert.deepStrictEqual(byKey.instagram, [2]);
  assert.deepStrictEqual(byKey.youtube, [3]);
});
t('empty categories and platforms with nothing usable are hidden', () => {
  const groups = groupCategoriesByPlatform([
    { id: 1, name: 'TikTok Likes', services: [] },
    { id: 2, name: 'Facebook Likes', services: [{ id: 9 }] },
    null,
  ]);
  assert.deepStrictEqual(groups.map((g) => g.key), ['facebook']);
  assert.strictEqual(groups[0].serviceCount, 1);
});
t('groups keep the fixed display order regardless of input order', () => {
  const groups = groupCategoriesByPlatform([
    { id: 1, name: 'TikTok Likes', services: [{ id: 1 }] },
    { id: 2, name: 'Instagram Likes', services: [{ id: 2 }] },
  ]);
  assert.deepStrictEqual(groups.map((g) => g.key), ['instagram', 'tiktok']);
});
t('option label shows the provider ID and a short one-line name', () => {
  const label = serviceOptionLabel({ id: 7, provider_service_id: 6197, name: 'Facebook Post Likes 👍 Hidden Data [ Max 10K ] 10k/day | No Refill ⚠️ | Instant Start' });
  assert.ok(label.startsWith('#6197 · Facebook Post Likes'));
  assert.ok(label.length <= 6 + 3 + 60, `too long: ${label.length}`);
  assert.ok(label.endsWith('…'));
});
t('option label falls back to the internal id only when no provider ID exists', () => {
  assert.strictEqual(serviceOptionLabel({ id: 42, provider_service_id: null, name: 'Short' }), '#42 · Short');
});
t('a short name is not truncated and whitespace is collapsed', () => {
  assert.strictEqual(serviceOptionLabel({ id: 1, provider_service_id: 5, name: '  Likes   Fast ' }), '#5 · Likes Fast');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
