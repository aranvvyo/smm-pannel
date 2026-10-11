// Pure display helpers for the service catalog. No React, no network.

// Price per 1000 units, in rupees. A positive rate is never shown as ₹0:
// sub-paisa rates are printed with their real value instead of being rounded.
export function fmtRatePer1k(rupees) {
  const r = Number(rupees);
  if (!Number.isFinite(r) || r <= 0) return 'No price';
  if (r >= 0.01) {
    return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return '₹' + r.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

// Platform groups, in the order they are shown to customers. Every category
// lands in exactly one group; anything unrecognised goes to "other".
export const PLATFORM_GROUPS = [
  { key: 'instagram', label: 'Instagram', emoji: '📸' },
  { key: 'youtube', label: 'YouTube', emoji: '▶️' },
  { key: 'telegram', label: 'Telegram', emoji: '✈️' },
  { key: 'x', label: 'X', emoji: '𝕏' },
  { key: 'facebook', label: 'Facebook', emoji: '📘' },
  { key: 'tiktok', label: 'TikTok', emoji: '🎵' },
  { key: 'other', label: 'Other platforms', emoji: '🌐' },
];

// Word-boundary matches only, checked in this order. "x" is matched only as
// a whole name ("X", "X Followers"), never as a word inside other text such as
// "Likes x 2", so unrelated categories are not tagged as X.
const PLATFORM_PATTERNS = [
  ['instagram', /\binstagram\b|\big\b/i],
  ['youtube', /\byoutube\b|\byt\b/i],
  ['telegram', /\btelegram\b/i],
  ['tiktok', /\btik\s?tok\b/i],
  ['facebook', /\bfacebook\b|\bfb\b/i],
  ['x', /\btwitter\b|^\s*x\s*$|^\s*x\s+\S/i],
];

// Platform key ("instagram", …, or "other") for a category or service name.
export function platformOf(name) {
  const n = String(name || '');
  for (const [key, re] of PLATFORM_PATTERNS) {
    if (re.test(n)) return key;
  }
  return 'other';
}

// Icon for a recognised platform, from the category or service name. Empty
// for unrecognised names, so no icon is invented for them. (The "other" group
// has its own fallback icon, used only as a group label.)
export function platformEmoji(name) {
  const key = platformOf(name);
  if (key === 'other') return '';
  return PLATFORM_GROUPS.find((g) => g.key === key)?.emoji ?? '';
}

// Non-empty categories grouped by platform, in PLATFORM_GROUPS order. Groups
// with no categories are dropped, so empty platforms never appear.
export function groupCategoriesByPlatform(categories) {
  const buckets = new Map(PLATFORM_GROUPS.map((g) => [g.key, []]));
  for (const c of categories || []) {
    if (!c || !Array.isArray(c.services) || c.services.length === 0) continue;
    buckets.get(platformOf(c.name)).push(c);
  }
  return PLATFORM_GROUPS
    .map((g) => {
      const cats = buckets.get(g.key);
      return {
        ...g,
        categories: cats,
        serviceCount: cats.reduce((n, c) => n + c.services.length, 0),
      };
    })
    .filter((g) => g.categories.length > 0);
}

// "#1234" label used for the dropdown and the detail panel. The provider
// service ID is preferred; the internal database id is only a fallback.
export function serviceIdLabel(service) {
  return service.provider_service_id != null ? `#${service.provider_service_id}` : `#${service.id}`;
}

// One-line option text for the service <select>. Long provider names are cut
// so every option stays a single readable line on a phone. Rate, min and max
// are shown in the detail panel below the select.
export function serviceOptionLabel(service, maxName = 60) {
  const name = String(service.name || '').replace(/\s+/g, ' ').trim();
  const short = name.length > maxName ? name.slice(0, maxName - 1).trimEnd() + '…' : name;
  return `${serviceIdLabel(service)} · ${short}`;
}
