/**
 * Device / enrollment secret hashing. Plain secrets are never stored.
 */
import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(plain, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('base64url');
  return { salt, hash };
}

export function verifySecret(plain, salt, hash) {
  if (!plain || !salt || !hash) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(plain), String(salt), KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    }).toString('base64url');
  } catch {
    return false;
  }
  const a = Buffer.from(derived);
  const b = Buffer.from(String(hash));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
