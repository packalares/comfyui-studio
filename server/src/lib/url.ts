// Strip a trailing slash (or run of them) from a URL or path string. Used
// before joining `${base}/${segment}` so we don't emit `//segment`. Callers
// that also need to trim user input should `.trim()` first.
export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
