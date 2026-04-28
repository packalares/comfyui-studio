// URL walker: HEAD-probe each candidate URL in priority order; the first
// that returns a 2xx becomes the streaming URL.
//
// Used by the unified download path (`services/models/models.service.ts:
// downloadCustom`) once a row carries a `urlSources[]` list. The walker
// reuses the same taskId + progress tracker across attempts so the UI's
// download-progress widget shows continuous motion.
//
// Decisions and their rationale:
//
//   - HEAD only fans out to the URLs we actually plan to stream from. We
//     stop probing as soon as one succeeds, so a happy-path multi-mirror
//     row only costs one HEAD beyond the existing engine HEAD.
//
//   - AUTH_REQUIRED on any URL is terminal: a missing token won't
//     materialise on a different mirror, and the gated-repo error must
//     reach the UI verbatim so the existing rendering (gated badge +
//     "configure HF token" prompt) lights up.
//
//   - URL_BROKEN / TRANSIENT errors fall through to the next URL. After
//     exhausting every candidate, the walker rejects with an aggregate
//     message listing each URL's failure mode so the user can copy-paste
//     it into a bug report.

import { logger } from '../../lib/logger.js';
import { getHostAuthHeaders } from '../../lib/http.js';
import { downloadModelByName } from './downloadController.service.js';
import { classifyWalkerError, type ClassifiedError } from './errorClassifier.js';
import type { UrlSource } from '../../contracts/catalog.contract.js';

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
    if (res.status === 401 || res.status === 403) {
      return { ok: false, classified: { code: 'AUTH_REQUIRED', message: `HTTP ${res.status} on HEAD ${url}` } };
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

// Re-export for tests.
export { classifyWalkerError } from './errorClassifier.js';
