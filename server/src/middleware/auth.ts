// Auth middleware for defineRoute-gated routes.
//
// Decision flow:
//   1. No `auth.required` on spec → pass.
//   2. Session cookie matches master + same-origin signal isn't 'reject'
//        → actor = ui (all scopes).
//   3. No (valid) cookie but same-origin signal is 'strong'/'weak'
//        → mint a fresh session cookie + treat as ui actor (first visit path).
//   4. `Authorization: Bearer sk_…` → prefix-lookup → hash verify → scope check.
//   5. Anything else → UnauthorizedError.
//
// Same-origin classification is in `lib/auth/session.ts` so the /ws upgrade
// gate can reuse the exact same logic.

import type { Request, Response, NextFunction } from 'express';
import { extractPrefix, verifyKey } from '../lib/auth/keyGen.js';
import { getApiKeyByPrefix, touchApiKey } from '../lib/db/apiKeys.repo.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { SCOPES, isScope, type Scope } from '../lib/auth/scopes.js';
import { matchesMasterKey } from '../lib/auth/masterKey.js';
import {
  classifySameOrigin,
  readSessionCookie,
  setSessionCookie,
} from '../lib/auth/session.js';
import type { AuthSpec } from '../lib/defineRoute.js';

export interface Actor {
  type: 'ui' | 'apiKey';
  id: string;
  scopes: Scope[];
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    routeAuth?: AuthSpec;
  }
}

function trustAsUi(req: Request): void {
  req.actor = { type: 'ui', id: 'ui', scopes: [...SCOPES] };
}

export function authMiddleware(auth: AuthSpec) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!auth.required) {
        next();
        return;
      }

      const sig = classifySameOrigin(req.headers);
      const cookie = readSessionCookie(req);
      const cookieOk = matchesMasterKey(cookie);

      // Path A — valid cookie. Trust unless the request is explicitly
      // cross-site (Sec-Fetch-Site present and != 'same-origin').
      if (cookieOk) {
        if (sig === 'reject') throw new UnauthorizedError();
        trustAsUi(req);
        next();
        return;
      }

      // Path B — no/invalid cookie but the request is verifiably same-origin.
      // Mint a fresh cookie now so subsequent calls take Path A. The cookie
      // is the master key itself; only same-origin requests will ever carry
      // it back to us (SameSite=Strict).
      if (sig === 'strong' || sig === 'weak') {
        setSessionCookie(res);
        trustAsUi(req);
        next();
        return;
      }

      // Path C — Bearer token (external clients).
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedError();
      }
      const plain = authHeader.slice('Bearer '.length).trim();
      const prefix = extractPrefix(plain);
      if (!prefix) throw new UnauthorizedError();

      const row = getApiKeyByPrefix(prefix);
      if (!row) throw new UnauthorizedError();
      if (row.revokedAt !== null) throw new UnauthorizedError();
      if (row.expiresAt !== null && row.expiresAt < Date.now()) throw new UnauthorizedError();
      if (!verifyKey(plain, row.hash)) throw new UnauthorizedError();

      const requiredScopes = (auth.scopes ?? []).filter(isScope) as Scope[];
      const keyScopes = new Set(row.scopes);
      if (!keyScopes.has('admin:all') && requiredScopes.length > 0) {
        const missing = requiredScopes.filter((s) => !keyScopes.has(s));
        if (missing.length > 0) throw new ForbiddenError();
      }

      req.actor = { type: 'apiKey', id: row.id, scopes: row.scopes };
      touchApiKey(row.id);
      next();
    } catch (err) {
      next(err);
    }
  };
}
