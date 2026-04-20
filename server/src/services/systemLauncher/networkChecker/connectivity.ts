// Low-level connectivity probe for a single service URL.
//
// The launcher used `superagent.get`/`superagent.head` with a small timeout.
// We route through `lib/exec.run('curl', [...])` as the constraint requires
// — argv-only, never a shell string. curl is present in every ComfyUI
// image the studio ships with; if a future deployment lacks it, the probe
// reports the service as inaccessible rather than throwing.

import { run } from '../../../lib/exec.js';

const CURL_RESPONSE_TIMEOUT_SEC = 5;
const CURL_TOTAL_TIMEOUT_SEC = 10;
// Hard per-subprocess ceiling. Tests kill runaway children.
const SUBPROCESS_HARD_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  accessible: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * HEAD-probe `url` via curl. Returns `{ accessible: true, status }` for 2xx
 * responses; otherwise records `status` (for 3xx/4xx/5xx) or an `error`
 * string. Never throws: all failure modes collapse into the negative
 * result so callers can record them uniformly.
 */
export async function probe(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<ProbeResult> {
  const args = buildCurlArgs(url, method);
  const started = Date.now();
  try {
    const r = await run('curl', args, { timeoutMs: SUBPROCESS_HARD_TIMEOUT_MS });
    const latencyMs = Date.now() - started;
    if (r.timedOut) {
      return { accessible: false, latencyMs, error: 'timeout' };
    }
    if (r.code !== 0) {
      return {
        accessible: false,
        latencyMs,
        error: `curl exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`,
      };
    }
    const status = parseStatus(r.stdout);
    if (status == null) {
      return { accessible: false, latencyMs, error: 'unparseable curl output' };
    }
    return {
      accessible: status >= 200 && status < 400,
      status,
      latencyMs,
    };
  } catch (err) {
    return {
      accessible: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a safe curl argv. Silences progress, caps redirects, prints only the status. */
function buildCurlArgs(url: string, method: 'HEAD' | 'GET'): string[] {
  return [
    method === 'HEAD' ? '-I' : '-sI',
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--connect-timeout',
    String(CURL_RESPONSE_TIMEOUT_SEC),
    '--max-time',
    String(CURL_TOTAL_TIMEOUT_SEC),
    '-L',
    '--max-redirs',
    '3',
    url,
  ];
}

function parseStatus(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
