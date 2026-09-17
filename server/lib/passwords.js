import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Zero native-dependency password hashing via node:crypto scrypt.
// Format: scrypt$<N>$<salt-hex>$<hash-hex>
const N = 16384;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, nStr, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, { N: parseInt(nStr, 10) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Basic email format gate + sanity (spec: simple @ presence check).
export function isValidEmail(email) {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}