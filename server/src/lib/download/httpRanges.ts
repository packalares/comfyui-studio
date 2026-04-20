// Redirect + Content-Length/Content-Range parsing helpers for the
// resumable downloader. Kept small and side-effect free so they can be
// unit-tested in isolation.

/** Return `true` for the HTTP status codes we follow as redirects. */
export function isRedirectStatus(code: number | undefined): boolean {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

/** Resolve a `Location` header value to an absolute URL. */
export function resolveRedirectUrl(location: string, currentUrl: string): string {
  const trimmed = (location || '').trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return new URL(trimmed, currentUrl).href;
}

/** Parse `Content-Range: bytes X-Y/TOTAL` and return the TOTAL (or null). */
export function parseContentRangeTotal(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/bytes\s+\d+-\d+\/(\d+)/);
  if (!match || !match[1]) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `Content-Length` header into a number, or 0 on failure. */
export function parseContentLength(raw: string | string[] | undefined): number {
  if (raw == null) return 0;
  const val = Array.isArray(raw) ? raw[0] : raw;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : 0;
}
