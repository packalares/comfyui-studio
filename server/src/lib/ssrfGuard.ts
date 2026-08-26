// SSRF guard shared by every code path that fetches a URL whose host may be
// influenced by user input (model resolvers, remote template import, remote
// thumbnail fetches).
//
// The barrier is `assertPublicHttpUrl`: it rejects non-http(s) schemes and any
// host that resolves to a private / loopback / link-local address — including
// DNS-rebind attempts (`evil.com` → 127.0.0.1) via an actual DNS lookup.
//
// NOTE: intentional calls to internal services (e.g. the in-pod ComfyUI at
// COMFYUI_URL, which is localhost) must NOT route through this guard — it would
// block them by design. Those sites fetch a fixed, non-user-controlled host.

import { promises as dns } from 'node:dns';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const PRIVATE_IPV4_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$)/;

export function isPrivateLiteralIp(host: string): boolean {
  if (host === '0.0.0.0' || host === '::1' || host === '127.0.0.1') return true;
  if (PRIVATE_IPV4_RE.test(host)) return true;
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 unique-local
  if (/^fe80::/i.test(host)) return true;            // link-local
  return false;
}

export async function isPrivateHost(hostname: string): Promise<boolean> {
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost')) return true;
  if (isPrivateLiteralIp(lc)) return true;
  // DNS-resolve to catch rebind attacks (`evil.com` → `127.0.0.1`).
  try {
    const { address } = await dns.lookup(lc);
    return isPrivateLiteralIp(address.toLowerCase());
  } catch {
    // DNS failure: caller's request will fail anyway. Treat as "not private"
    // here so a transient DNS hiccup doesn't masquerade as an SSRF rejection.
    return false;
  }
}

/**
 * Validate that `url` is a public http(s) URL and return the parsed URL.
 * Throws `SsrfError` for a malformed URL, a non-http(s) scheme, or a host that
 * resolves to a private/loopback/link-local address. Use as a barrier
 * immediately before any `fetch()` whose host may be user-influenced.
 */
export async function assertPublicHttpUrl(url: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfError(`Disallowed URL scheme: ${u.protocol}`);
  }
  if (await isPrivateHost(u.hostname)) {
    throw new SsrfError(`Blocked private host: ${u.hostname}`);
  }
  return u;
}
