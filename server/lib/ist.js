import 'dotenv/config';

// IST (India Standard Time, UTC+5:30) display helpers.
// All storage remains epoch-millis UTC; IST is applied only when rendering
// timestamps to a human (admin panels, logs, order dates).
const IST_OFFSET = 5 * 3600 + 1800; // seconds ahead of UTC

export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export function fmtIST(ms) {
  const p = istParts(ms);
  const ymd = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const hms = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
  return `${ymd} ${hms} IST`;
}

export function fmtISTShort(ms) {
  const p = istParts(ms);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Start (epoch ms, UTC-based) of the IST day/month containing `ms`.
export function startOfISTDay(ms) {
  const p = istParts(ms);
  // Rebuild as if UTC; then subtract offset to get the real instant.
  return Date.UTC(p.year, p.month - 1, p.day) - IST_OFFSET * 1000;
}
export function startOfISTMonth(ms) {
  const p = istParts(ms);
  return Date.UTC(p.year, p.month - 1, 1) - IST_OFFSET * 1000;
}