// Thin wrapper around `fetch` that injects `Sec-Fetch-Site: same-origin`.
// The auth middleware classifies this as `'strong'` same-origin signal and
// mints a session cookie on the first call (Path B), so tests bypass the
// cookie requirement without setting one explicitly.

export async function authedFetch(
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Sec-Fetch-Site', 'same-origin');
  return fetch(url, { ...init, headers });
}
