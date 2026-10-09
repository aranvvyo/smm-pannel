// Unit tests for the money engine (no framework — run: node scripts/test-money.mjs)
import { priceFor, computePricing, applyMarkup, clampDiscount, usdToInr, inrToUsd } from '../server/lib/money.js';
import assert from 'node:assert';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  PASS  ${name}`); };

console.log('Money engine tests');

t('priceFor returns paise (₹15 per 1k × 1000 → 1500paise = ₹15)', () => {
  assert.strictEqual(priceFor(1000, 15), 1500);
  assert.strictEqual(priceFor(100, 9), 90);
  assert.strictEqual(priceFor(250, 12), 300);
});

t('applyMarkup percent + fixed', () => {
  assert.strictEqual(applyMarkup(12, 'percent', 25), 15);
  assert.strictEqual(applyMarkup(12, 'percent', 0), 12);
  assert.strictEqual(applyMarkup(10, 'fixed', 3), 13);
});

t('computePricing no-profit equals base', () => {
  const p = computePricing({ qty: 1000, adminRate: 15, baseRate: 12, noProfit: true });
  assert.strictEqual(p.price, 1200);   // base rate only
  assert.strictEqual(p.base, 1200);
});

t('computePricing normal user with markup', () => {
  const p = computePricing({ qty: 1000, adminRate: 15, baseRate: 12, noProfit: false });
  assert.strictEqual(p.base, 1200);
  assert.strictEqual(p.price, 1500);
  assert.strictEqual(p.final, 1500);
});

t('coupon percent discount', () => {
  const p = computePricing({ qty: 1000, adminRate: 15, baseRate: 12, coupon: { type: 'percent', value: 10 } });
  assert.strictEqual(p.discount, 150);
  assert.strictEqual(p.final, 1350); // never below base 1200
});

t('coupon fixed over-discount is clamped to base (no-loss)', () => {
  const p = computePricing({ qty: 1000, adminRate: 15, baseRate: 12, coupon: { type: 'fixed_inr', value: 10000 } });
  assert.strictEqual(p.discount, 300); // max allowed = 1500-1200
  assert.strictEqual(p.final, 1200);   // exactly base cost
});

t('clampDiscount never goes negative', () => {
  assert.strictEqual(clampDiscount(0, 1000, 1100), 0);
  assert.strictEqual(clampDiscount(5000, 1000, 1100), 0);
});

t('no-loss invariant for random cases', () => {
  for (let i = 0; i < 500; i++) {
    const qty = Math.floor(Math.random() * 10000) + 1;
    const baseRate = Math.floor(Math.random() * 50) + 1;
    const markup = Math.floor(Math.random() * 100);
    const adminRate = applyMarkup(baseRate, 'percent', markup);
    const coupon = i % 3 === 0 ? { type: 'percent', value: 90 } : { type: 'fixed_inr', value: 1000000 };
    const p = computePricing({ qty, adminRate, baseRate, coupon });
    assert.ok(p.final >= p.base, `final ${p.final} < base ${p.base}`);
  }
});

t('USD ↔ INR conversions', () => {
  assert.strictEqual(usdToInr(100, 100), 10000);   // $1.00 = 100¢ × 100 → 10,000 paise = ₹100.00
  assert.strictEqual(inrToUsd(100000, 100), 100000 / 100);
});

t('deposit conversion: $1 → ₹100', () => {
  assert.strictEqual(usdToInr(100, 100), 10000);   // ₹100.00
});

t('deposit conversion: $10 → ₹1,000', () => {
  assert.strictEqual(usdToInr(1000, 100), 100000); // ₹1,000.00
});

t('deposit conversion: $100 → ₹10,000', () => {
  assert.strictEqual(usdToInr(10000, 100), 1000000); // ₹10,000.00
});

t('deposit conversion is integer-safe (no float drift)', () => {
  // 99.99 USD must be exactly 9999 cents → 999,900 paise, never 999899.999…
  assert.strictEqual(usdToInr(9999, 100), 999900);
  assert.strictEqual(Number.isInteger(usdToInr(9999, 73)), true);
});

// ---- Regression: valid fractional rates must never become ₹0.00 -----------
// Root cause was Math.round on rupees-per-1000 rates (₹0.45 → 0).
import { normalizeRate, displayRatePer1k } from '../server/lib/money.js';

t('fractional provider rate with 25% markup stays positive (₹0.40 → ₹0.50, not ₹0)', () => {
  const sell = applyMarkup(0.4, 'percent', 25);
  assert.ok(sell > 0, 'must not round to zero');
  assert.strictEqual(sell, 0.5);
});

t('sub-₹1 rate with 0% markup is kept exactly (₹0.45 stays ₹0.45)', () => {
  assert.strictEqual(applyMarkup(0.45, 'percent', 0), 0.45);
  assert.strictEqual(applyMarkup(0.45, 'fixed', 0), 0.45);
});

t('fixed markup on a fractional rate is exact', () => {
  assert.strictEqual(applyMarkup(0.45, 'fixed', 0.5), 0.95);
});

t('client price_per_1k keeps decimals (₹0.45 is not shown as ₹0)', () => {
  assert.strictEqual(displayRatePer1k(0.45), 0.45);
  assert.strictEqual(displayRatePer1k(12.5), 12.5);
  assert.strictEqual(normalizeRate(0.1 + 0.2), 0.3);   // no float drift in storage
});

t('a fractional valid price orders at a positive total (₹0.45/1k × 1000 → 45 paise)', () => {
  const p = computePricing({ qty: 1000, adminRate: applyMarkup(0.36, 'percent', 25), baseRate: 0.36, noProfit: false });
  assert.strictEqual(p.final, 45);   // ₹0.45 = 45 paise, positive
});

t('a genuine zero rate still prices to zero (the order guard keeps refusing it)', () => {
  assert.strictEqual(applyMarkup(0, 'percent', 25), 0);
  const p = computePricing({ qty: 1000, adminRate: 0, baseRate: 0, noProfit: false });
  assert.ok(p.final <= 0, 'zero rate must still be refused by the BAD_PRICE guard');
});

console.log(`\n${pass} tests passed`);