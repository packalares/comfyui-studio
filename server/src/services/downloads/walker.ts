// URL walker + error classifier.
//
// HEAD-probe each candidate URL in priority order; the first that returns a
// 2xx becomes the streaming URL. `classifyWalkerError` drives the walk
// fall-through decision and is also exported for tests.
//
// Walk decisions:
//   - AUTH_REQUIRED on any URL is terminal: a missing token won't
//     materialise on a different mirror, and the gated-repo error must
//     reach the UI verbatim so the existing rendering (gated badge +
//     "configure HF token" prompt) lights up.
//   - URL_BROKEN / TRANSIENT errors fall through to the next URL. After
//     exhausting every candidate, the walker rejects with an aggregate
//     message listing each URL's failure mode so the user can copy-paste
//     it into a bug report.

import { logger } from '../../lib/logger.js';
import { getHostAuthHeaders } from '../../lib/http.js';
import { downloadModelByName } from './controller.js';
import type { UrlSource } from '../../contracts/catalog.contract.js';

// ── Error classifier ──────────────────────────────────────────────────────────

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

// ── Walker ────────────────────────────────────────────────────────────────────

export interface WalkerTokens {
  hfToken?: string;
  civitaiToken?: string;
  githubToken?: string;
}

export interface WalkerOptions {
  modelName: string;
  outputPath: string;
  taskId: string;
  /** Priority-sorted candidate list. Caller is responsible for sort + dedup. */
  candidates: UrlSource[];
  tokens: WalkerTokens;
  /** Optional source tag forwarded to the controller for history rows. */
  source?: string;
}

interface AttemptOutcome {
  url: string;
  classified: ClassifiedError;
}

type ProbeOutcome =
  | { ok: true }
  | { ok: false; classified: ClassifiedError };

/**
 * Run a HEAD-probe walk over `candidates` and stream the first URL that
 * accepts the request. AUTH_REQUIRED on any URL throws immediately so the
 * caller can surface the gated-repo error.
 */
export async function walkAndDownload(opts: WalkerOptions): Promise<{ url: string }> {
  if (opts.candidates.length === 0) throw new Error('No download candidates');
  const failures: AttemptOutcome[] = [];
  for (const candidate of opts.candidates) {
    const probe = await probeUrl(candidate.url, opts.tokens);
    if (!probe.ok) {
      failures.push({ url: candidate.url, classified: probe.classified });
      if (probe.classified.code === 'AUTH_REQUIRED') {
        throw new Error(probe.classified.message);
      }
      continue;
    }
    try {
      await downloadModelByName(opts.modelName, candidate.url, opts.outputPath, opts.taskId, {
        source: opts.source,
        authHeaders: getHostAuthHeaders(candidate.url, opts.tokens),
      });
      return { url: candidate.url };
    } catch (err) {
      const classified = classifyWalkerError(err);
      failures.push({ url: candidate.url, classified });
      if (classified.code === 'AUTH_REQUIRED') {
        throw err;
      }
      logger.warn('walker stream failed; trying next URL', {
        url: candidate.url, code: classified.code, message: classified.message,
      });
    }
  }
  throw new Error(buildAggregateError(failures));
}

async function probeUrl(url: string, tokens: WalkerTokens): Promise<ProbeOutcome> {
  const headers = getHostAuthHeaders(url, tokens);
  try {
    const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401) {
      return { ok: false, classified: { code: 'AUTH_REQUIRED', message: `HTTP ${res.status} on HEAD ${url}` } };
    }
    // CDNs that issue AWS-Sig-V4 signed redirects (CivitAI → R2, HF LFS →
    // CloudFront, S3 pre-signed URLs) sign the URL for GET only — sending
    // HEAD against the signed target returns 403 because the method is part
    // of the canonical request. 405 is the explicit "method not allowed"
    // variant. Retry once as a 1-byte Range GET before deciding whether the
    // failure is real auth or a signed-URL method mismatch.
    if (res.status === 403 || res.status === 405) {
      const getRes = await fetch(url, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
        redirect: 'follow',
      });
      // Discard the (at most 1-byte) body without consuming it.
      try { await getRes.body?.cancel(); } catch { /* best effort */ }
      if (getRes.status >= 200 && getRes.status < 300) return { ok: true };
      if (getRes.status === 401 || getRes.status === 403) {
        return { ok: false, classified: { code: 'AUTH_REQUIRED', message: `HTTP ${getRes.status} on GET ${url}` } };
      }
      return { ok: false, classified: { code: 'URL_BROKEN', message: `HTTP ${getRes.status} on GET ${url}` } };
    }
    if (res.status >= 400) {
      return { ok: false, classified: { code: 'URL_BROKEN', message: `HTTP ${res.status} on HEAD ${url}` } };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, classified: classifyWalkerError(err) };
  }
}

function buildAggregateError(failures: AttemptOutcome[]): string {
  if (failures.length === 0) return 'walker exhausted with no failures';
  const lines = failures.map(f => `  - ${f.url}: ${f.classified.code} (${f.classified.message})`);
  return `All ${failures.length} download URL(s) failed:\n${lines.join('\n')}`;
}
