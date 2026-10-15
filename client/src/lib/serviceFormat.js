// Pure display helpers for the service catalog. No React, no network.

// Display-only cleanup for supplier-provided names: Unicode-normalises, removes
// control characters, drops zero-width characters, turns non-breaking spaces into spaces, and
// collapses runs of whitespace. Never changes letters, digits or punctuation, and
// is never written back to the database. ZWJ/ZWNJ are kept so emoji still render.
export function cleanDisplayText(v) {
  return String(v ?? '')
    .normalize('NFC')
    .replace(/[\u200B\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


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

// Platform detection from a category or service name, used only for the
// small emoji shown before category names. Word-boundary matches only, checked
// in this order. "x" matches only as a whole name ("X", "X Followers"), never
// as a word inside other text such as "Likes x 2".
const PLATFORM_PATTERNS = [
  ['instagram', /\binstagram\b|\big\b/i],
  ['youtube', /\byoutube\b|\byt\b/i],
  ['telegram', /\btelegram\b/i],
  ['tiktok', /\btik\s?tok\b/i],
  ['facebook', /\bfacebook\b|\bfb\b/i],
  ['x', /\btwitter\b|^\s*x\s*$|^\s*x\s+\S/i],
];

// Existing project icon names (client/src/ui.jsx) used as platform markers.
// These are simple, neutral glyphs, not brand logos, so no misleading logo is
// implied. Platforms without a matching icon get no marker.
const PLATFORM_ICON = {
  instagram: 'camera',
  youtube: 'play',
  telegram: 'send',
  x: 'birds',
  facebook: 'thumbsUp',
  tiktok: 'music',
};

// Platform key ("instagram", …) or "other" for a category or service name.
export function platformOf(name) {
  const n = String(name || '');
  for (const [key, re] of PLATFORM_PATTERNS) {
    if (re.test(n)) return key;
  }
  return 'other';
}

// Icon name for a recognised platform, or null for anything else.
export function platformIcon(name) {
  return PLATFORM_ICON[platformOf(name)] ?? null;
}

// Categories that contain at least one service, in their given order. Empty
// and malformed categories are dropped so they never reach the dropdown.
export function usableCategories(categories) {
  return (categories || []).filter((c) => c && Array.isArray(c.services) && c.services.length > 0);
}

// Refill/Cancel flags. The server sends 0 or 1 (booleans are accepted too).
// Returns null when the provider gave no value, so the row is omitted rather
// than shown as a guess.
export function flagLabel(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number(v) ? 'Available' : 'Not available';
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
  const name = cleanDisplayText(service.name);
  const short = name.length > maxName ? name.slice(0, maxName - 1).trimEnd() + '…' : name;
  return `${serviceIdLabel(service)} · ${short}`;
}
