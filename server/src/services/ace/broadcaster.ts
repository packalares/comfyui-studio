// WS broadcast hub for the ACE-Step music/TTS/training pages. Mirrors
// `services/chat/broadcaster.ts` / `services/videoboard/jobTracker.ts`'s
// setter pattern: wired once at boot (`setAceBroadcaster(broadcast)` in
// `index.ts`), consumed by every ACE-Step route/service that needs to push a
// state change instead of making the client poll for it.
//
// Message shape on the wire is always `{ type, data }` — same envelope every
// other WS push in this app uses (`{type:'download', data}`,
// `{type:'gpu', data}`, ...). Callers pass the full `type` string (e.g.
// `'ace:generation'`) so this module stays payload-shape-agnostic.

let broadcaster: ((message: object) => void) | null = null;

export function setAceBroadcaster(fn: ((message: object) => void) | null): void {
  broadcaster = fn;
}

export function broadcastAce(type: string, data: unknown): void {
  if (broadcaster) broadcaster({ type, data });
}
