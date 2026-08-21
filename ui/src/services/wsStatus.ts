// Lightweight, non-React mirror of `AppContext`'s `wsConnected` flag.
//
// Plain service modules (`services/ace.ts`'s `pollGenerationStatus` /
// `pollTtsStatus`) need to know whether the shared page-level `/ws` socket
// is currently open, so their fallback poll loop can skip doing real
// network work while push is available — but they aren't components and
// can't call the `useApp()` hook. `AppContext` calls `setWsConnected` here
// alongside its own React state, on every `ws.onopen`/`ws.onclose`.

let connected = false;

export function setWsConnected(value: boolean): void {
  connected = value;
}

export function isWsConnected(): boolean {
  return connected;
}
