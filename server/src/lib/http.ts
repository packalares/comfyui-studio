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
