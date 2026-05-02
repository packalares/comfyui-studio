// Tiny broadcaster wire — `index.ts` installs the WS broadcast function on
// boot via `setChatBroadcaster`. Streaming chat + model-pull progress flow
// through it as `chat:*` / `model:pull:*` envelopes.

let broadcaster: ((message: object) => void) | null = null;

export function setChatBroadcaster(fn: ((message: object) => void) | null): void {
  broadcaster = fn;
}

export function emitChatEvent(message: object): void {
  if (broadcaster) broadcaster(message);
}
