// URL validators extracted from models.routes.ts so the route file stays
// focused on handler wiring.

// Reject non-HTTP(S) URLs for download-custom: the downloader fetches the URL
// directly, so any schema we let through (data:, file:, gopher:, ...) would
// give the server's fetcher an opportunity to read local paths.
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^https?:\/\//i.test(value);
}

// SSRF guard: user-supplied hostnames must not resolve to loopback or
// private address ranges. Literal-match only — sufficient because users can
// side-load via the launcher CLI for their own LAN.
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127(?:\.\d{1,3}){3}$/,
  /^10(?:\.\d{1,3}){3}$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^::1$/,
  /^\[::1\]$/,
  /^0\.0\.0\.0$/,
];

export function hostIsPrivate(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname;
    return PRIVATE_HOST_PATTERNS.some(re => re.test(host));
  } catch {
    return true;
  }
}
