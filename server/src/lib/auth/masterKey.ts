// Server-side master key — bootstraps trust for the UI.
//
// Lives at `paths.runtimeStateDir/master.key` (next to studio.db so it shares
// the same persistent volume). Auto-generated on first boot when missing.
// 32 bytes (256 bits) of CSPRNG entropy, hex-encoded → 64-character string.
//
// The key is loaded into memory once and never written to logs, never
// returned by any API endpoint, never surfaced in the Access UI. The only
// way to read it is to SSH into the host and `cat master.key`.
//
// Verification is constant-time so callers can't probe via timing.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { paths } from '../../config/paths.js';
import { logger } from '../logger.js';

const MASTER_KEY_FILE = 'master.key';

let cached: string | null = null;
let cachedBuf: Buffer | null = null;

function filePath(): string {
  return path.join(paths.runtimeStateDir, MASTER_KEY_FILE);
}

function generateAndWrite(target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(target, key, { mode: 0o600 });
  // Belt-and-braces chmod in case umask interfered.
  try { fs.chmodSync(target, 0o600); } catch { /* non-fatal */ }
  logger.info('master key: generated', { path: target });
  return key;
}

/**
 * Read the master key from disk, generating it on first boot. Synchronous so
 * downstream modules can call it during their own boot init without making
 * everything async. Cached after the first read.
 */
export function getMasterKey(): string {
  if (cached !== null) return cached;
  const target = filePath();
  if (fs.existsSync(target)) {
    const raw = fs.readFileSync(target, 'utf8').trim();
    cached = raw.length > 0 ? raw : generateAndWrite(target);
  } else {
    cached = generateAndWrite(target);
  }
  cachedBuf = Buffer.from(cached, 'utf8');
  return cached;
}

/** Constant-time compare against the master key. Returns false on null/empty input. */
export function matchesMasterKey(candidate: string | undefined | null): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (cachedBuf === null) getMasterKey();
  if (cachedBuf === null) return false;
  if (candidate.length !== cachedBuf.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate, 'utf8'), cachedBuf);
  } catch {
    return false;
  }
}
