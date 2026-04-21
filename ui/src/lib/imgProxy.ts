// Build a URL pointing at the backend /api/img proxy + md5 disk cache.
//
// The proxy fetches an upstream image (civitai / huggingface / whitelisted
// CDNs), resizes to `width` via sharp, caches it on disk, and serves the
// resized webp. See `server/src/services/imgProxy/imgProxy.service.ts`.
//
// Usage in components: replace a raw `<img src={imageUrl}>` with
// `<img src={imgProxy(imageUrl, 320)}>`. Same-origin paths (anything that
// starts with `/`) are returned unchanged so locally-served assets like
// `/api/view` or `/api/template-asset/*` keep working with no round-trip.

/**
 * Convert an external image URL into a same-origin proxy URL that goes
 * through /api/img?url=...&w=... . Returns undefined when `url` is falsy
 * so consumers can spread the result into `<img src={...}>`-style JSX
 * without a null-check cascade.
 *
 * Same-origin paths (starting with `/`) short-circuit: the backend (or
 * vite dev server) already serves them, so there is nothing to proxy.
 */
export function imgProxy(
  url: string | null | undefined,
  width: number,
): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return url;
  const params = new URLSearchParams({
    url,
    w: String(width),
    fmt: 'webp',
  });
  return `/api/img?${params.toString()}`;
}
