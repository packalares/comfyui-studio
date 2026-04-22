// Build a URL pointing at the backend /api/thumbnail URL-mode endpoint.
//
// Migrated from the legacy /api/img endpoint to the unified thumbnail
// service. Server-side dispatch still ends in a sharp-resized webp cached
// on disk; this helper's shape (`imgProxy(url, width)`) is preserved so
// existing call sites don't need to change.
//
// Usage in components: `<img src={imgProxy(imageUrl, 320)}>`. Same-origin
// paths (anything that starts with `/`) are returned unchanged so locally-
// served assets like `/api/view` or `/api/template-asset/*` keep working
// with no round-trip.

/**
 * Convert an external image URL into a same-origin thumbnail URL that goes
 * through /api/thumbnail?url=...&w=... . Returns undefined when `url` is
 * falsy so consumers can spread the result into `<img src={...}>`-style
 * JSX without a null-check cascade.
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
  });
  return `/api/thumbnail?${params.toString()}`;
}
