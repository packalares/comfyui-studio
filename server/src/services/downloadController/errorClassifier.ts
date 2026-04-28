// Walker-side error classification.
//
// The URL walker (`walker.ts`) needs to know whether a per-attempt failure
// should stop the walk (auth required — surface to the user) or just fall
// through to the next URL (404, host-rejected, transient broken). The
// engine's own retry policy still handles transient network drops within
// a single URL attempt; this classifier is strictly about the cross-URL
// fall-through decision.

export type WalkerErrorCode = 'AUTH_REQUIRED' | 'URL_BROKEN' | 'TRANSIENT';

export interface ClassifiedError {
  code: WalkerErrorCode;
  /** Original message preserved for the aggregate error report. */
  message: string;
}

/**
 * Classify a thrown error from a download attempt.
 *
 * Auth-required (401/403) is terminal at the walker level: a different
 * mirror won't fix the user's missing token, and silently continuing past
 * a gated-repo error would just spam HEAD requests at every mirror. The
 * route layer surfaces this through the existing gated-error rendering
 * (model.gated / model.gated_message — see `services/catalog.ts`).
 */
export function classifyWalkerError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  // Engine throws "HTTP 401" / "HTTP 403" verbatim from `stream.ts:58`.
  if (/^HTTP 40[13]\b/.test(message)) {
    return { code: 'AUTH_REQUIRED', message };
  }
  // 4xx other than auth: subsequent mirrors might succeed (404 on a stale
  // CDN, 410 gone, etc.) so we fall through. 5xx are also classed as broken
  // for the next-mirror try; the walker still aggregates messages so the
  // user sees the cause if every URL fails.
  if (/^HTTP [45]\d\d\b/.test(message)) {
    return { code: 'URL_BROKEN', message };
  }
  // Anything else is classed as transient; the engine retried already, the
  // walker now tries the next URL because the current one looks unreliable.
  return { code: 'TRANSIENT', message };
}
