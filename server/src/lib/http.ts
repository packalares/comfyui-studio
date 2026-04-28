// Shared HTTP helpers.

/**
 * Authorization headers to send alongside HuggingFace-hosted download/HEAD
 * requests. Returns an empty object for non-HF URLs so callers can always
 * spread the result safely.
 */
export function getHfAuthHeaders(
  url: string,
  token: string | undefined,
): Record<string, string> {
  if (!token) return {};
  if (!/huggingface\.co/.test(url)) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Authorization headers to send alongside civitai.com-hosted download/HEAD
 * requests. Returns an empty object for non-civitai URLs or when no token is
 * configured. CivitAI accepts `Bearer <token>` on its REST endpoints and
 * passes the redirect through unchanged.
 */
export function getCivitaiAuthHeaders(
  url: string,
  token: string | undefined,
): Record<string, string> {
  if (!token) return {};
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return {}; }
  if (host !== 'civitai.com' && host !== 'www.civitai.com') return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Authorization headers for GitHub-hosted assets (release downloads + the
 * api.github.com size-probe used by `resolveGithub`). GitHub accepts both
 * `Bearer <pat>` and `token <pat>`; we use Bearer for parity with HF+civitai.
 *
 * Allowed hosts include the canonical github.com / api.github.com plus the
 * signed-asset CDN that releases redirect to (objects.githubusercontent.com)
 * — without that the redirect strips Authorization and the download fails
 * with a 403 even when the token is valid.
 */
export function getGithubAuthHeaders(
  url: string,
  token: string | undefined,
): Record<string, string> {
  if (!token) return {};
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return {}; }
  const allow = new Set([
    'github.com', 'www.github.com', 'api.github.com',
    'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ]);
  if (!allow.has(host)) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Host-aware auth header resolver used by the unified `download-custom`
 * endpoint. Picks the correct token based on the URL's host family and
 * silently returns an empty object for unsupported hosts so callers get a
 * clean anonymous request.
 */
export function getHostAuthHeaders(
  url: string,
  tokens: { hfToken?: string; civitaiToken?: string; githubToken?: string },
): Record<string, string> {
  const hf = getHfAuthHeaders(url, tokens.hfToken);
  if (Object.keys(hf).length > 0) return hf;
  const civitai = getCivitaiAuthHeaders(url, tokens.civitaiToken);
  if (Object.keys(civitai).length > 0) return civitai;
  return getGithubAuthHeaders(url, tokens.githubToken);
}

export interface FetchWithRetryOptions {
  attempts?: number;
  /** Initial delay ms, doubled after each failure up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Abort after this many ms per attempt. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Hard cap on response body bytes read. Throws RangeError when exceeded. */
  maxBytes?: number;
}

export interface FetchWithRetryResult {
  status: number;
  headers: Record<string, string>;
  /** Raw body as a UTF-8 string. Size-capped per `maxBytes`. */
  text: string;
}

/**
 * GET `url` with exponential-backoff retries. Every attempt is size-capped so
 * a misbehaving upstream cannot balloon memory. Non-2xx responses throw.
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchWithRetryOptions = {},
): Promise<FetchWithRetryResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = Math.max(10, opts.baseDelayMs ?? 500);
  const maxDelay = Math.max(base, opts.maxDelayMs ?? 8_000);
  const timeout = Math.max(1_000, opts.timeoutMs ?? 15_000);
  const maxBytes = Math.max(1_024, opts.maxBytes ?? 10 * 1024 * 1024);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await singleFetch(url, timeout, maxBytes, opts.headers);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = Math.min(maxDelay, base * 2 ** i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function singleFetch(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  headers: Record<string, string> | undefined,
): Promise<FetchWithRetryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const hdrs: Record<string, string> = {};
    res.headers.forEach((v, k) => { hdrs[k] = v; });
    const declared = parseInt(hdrs['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RangeError(`response exceeds max bytes (${declared} > ${maxBytes})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new RangeError(`response exceeds max bytes (${buf.byteLength} > ${maxBytes})`);
    }
    if (res.status < 200 || res.status >= 300) {
      const text = new TextDecoder('utf-8').decode(buf);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, headers: hdrs, text: new TextDecoder('utf-8').decode(buf) };
  } finally {
    clearTimeout(timer);
  }
}
