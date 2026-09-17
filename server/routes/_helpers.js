// Small shared helpers for route modules.
import { config } from '../config.js';

export function sendErr(res, status, messageOrErr, code) {
  const message = messageOrErr?.message || messageOrErr || 'Something went wrong.';
  const payload = { error: message };
  if (code) payload.code = code;
  return res.status(status).json(payload);
}

// Wrap async handlers so rejections reach error middleware.
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const timeAgo = (ms) => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export { config };