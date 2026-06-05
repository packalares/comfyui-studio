// Session cookie + same-origin signal — shared between the express auth
// middleware and the WebSocket `verifyClient` hook so both gates apply
// identical logic.
//
// Cookie: `studio_session` — HttpOnly, SameSite=Strict, Path=/, Secure in
// production. Value is the server's master key (see masterKey.ts). The
// browser auto-sends it on every same-site fetch + WS upgrade; JS can't
// read it (HttpOnly), so XSS can't exfiltrate.
//
// Same-origin signal classification:
//   - 'strong'  — `Sec-Fetch-Site: same-origin` (browser-asserted, unforgeable)
//   - 'weak'    — `Sec-Fetch-Site` absent + Origin host matches request host
//                 (legacy browsers, certain proxies that strip Fetch Metadata)
//   - 'none'    — neither signal present (curl, Python scripts, etc.)
//   - 'reject'  — `Sec-Fetch-Site` present and != 'same-origin'
//                 (cross-site or cross-origin request — never trust)

import type { IncomingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';
import { getMasterKey } from './masterKey.js';
import { isProduction } from '../../config/env.js';

export const SESSION_COOKIE_NAME = 'studio_session';

export type SameOriginSignal = 'strong' | 'weak' | 'none' | 'reject';

/** Parse a single named cookie value out of a Cookie header. */
export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function readSessionCookie(req: Request): string | undefined {
  return readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
}

export function readSessionCookieFromHeaders(
  headers: IncomingHttpHeaders,
): string | undefined {
  return readCookie(headers.cookie, SESSION_COOKIE_NAME);
}

/** Emit `Set-Cookie` for the session cookie on the response. */
export function setSessionCookie(res: Response): void {
  const flags = [
    `${SESSION_COOKIE_NAME}=${getMasterKey()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isProduction()) flags.push('Secure');
  // Append rather than overwrite so we don't clobber other cookies a route
  // might have set earlier in the chain.
  const existing = res.getHeader('Set-Cookie');
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, flags.join('; ')]);
  } else if (typeof existing === 'string') {
    res.setHeader('Set-Cookie', [existing, flags.join('; ')]);
  } else {
    res.setHeader('Set-Cookie', flags.join('; '));
  }
}

function originMatchesHost(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  const fwd = headers['x-forwarded-host'];
  const host = typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export function classifySameOrigin(headers: IncomingHttpHeaders): SameOriginSignal {
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite === 'same-origin') return 'strong';
  if (typeof fetchSite === 'string' && fetchSite.length > 0) return 'reject';
  return originMatchesHost(headers) ? 'weak' : 'none';
}
