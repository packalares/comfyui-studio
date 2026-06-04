// API key generation + verification.
//
// Wire format:
//   plain  = `<prefix>_<secret>` where
//            prefix = "sk_" + 4 chars from URL-safe alphabet (no 0/O/1/l/I)
//            secret = 32 chars from the same alphabet (= 160 bits of entropy)
//   hash   = sha-256 hex digest of the plain string
//
// Why sha-256 and not bcrypt: the plain key carries 160+ bits of crypto-random
// entropy from `crypto.randomBytes`, so a preimage attack is computationally
// infeasible regardless of hash cost. Bcrypt's slow-hash protection exists to
// defend user-chosen passwords; it adds no security here while requiring a new
// dependency not currently in package.json. SHA-256 is stdlib and lets us verify
// in microseconds with a constant-time compare via `timingSafeEqual`.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// URL-safe alphabet with ambiguous characters (0/O/1/l/I) removed so a user
// reading a key off a screen can type it back without misreads.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PREFIX_TAG = 'sk_';
const PREFIX_SLUG_LEN = 4;
const SECRET_LEN = 32;

function randomSlug(length: number): string {
  // Rejection-sample bytes so each character is drawn from a uniform
  // distribution over ALPHABET. `randomBytes` is the CSPRNG.
  const out: string[] = [];
  const mod = ALPHABET.length;
  const limit = 256 - (256 % mod);
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i]!;
      if (b >= limit) continue;
      out.push(ALPHABET[b % mod]!);
    }
  }
  return out.join('');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface GeneratedKey {
  /** Non-secret identifier: `sk_xxxx`. Safe to store + display in the UI. */
  prefix: string;
  /** Full plain secret returned to the caller exactly once. */
  plain: string;
  /** Hex sha-256 of `plain`. Persisted; never re-derivable to `plain`. */
  hash: string;
}

export function generateKey(): GeneratedKey {
  const prefix = `${PREFIX_TAG}${randomSlug(PREFIX_SLUG_LEN)}`;
  const secret = randomSlug(SECRET_LEN);
  const plain = `${prefix}_${secret}`;
  const hash = sha256Hex(plain);
  return { prefix, plain, hash };
}

/**
 * Constant-time verify. Returns false on any malformed input rather than
 * throwing so callers can treat verification failure uniformly.
 */
export function verifyKey(plain: string, hash: string): boolean {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  if (plain.length === 0 || hash.length === 0) return false;
  const candidate = sha256Hex(plain);
  if (candidate.length !== hash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(hash, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Extract the prefix segment from a presented plain key without trusting the
 * caller's slicing. Returns null when the input isn't shaped like a valid key.
 * Middleware uses this to look the row up in `api_keys.prefix` before running
 * the expensive constant-time verify against the stored hash.
 */
export function extractPrefix(plain: string): string | null {
  if (typeof plain !== 'string') return null;
  if (!plain.startsWith(PREFIX_TAG)) return null;
  const expectedPrefixLen = PREFIX_TAG.length + PREFIX_SLUG_LEN;
  if (plain.length < expectedPrefixLen + 1 + SECRET_LEN) return null;
  if (plain[expectedPrefixLen] !== '_') return null;
  const prefix = plain.slice(0, expectedPrefixLen);
  for (let i = PREFIX_TAG.length; i < prefix.length; i++) {
    if (!ALPHABET.includes(prefix[i]!)) return null;
  }
  return prefix;
}
