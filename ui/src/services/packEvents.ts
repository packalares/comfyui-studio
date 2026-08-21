// Capability-pack install/uninstall progress events.
//
// Typed event-emitter facade mirroring `videoboardEvents.ts` — this module
// does NOT open its own WebSocket. `AppContext` (the single owner of the
// page-level `ws://.../ws` connection) detects `pack:progress` messages in
// `ws.onmessage` and routes them here via `dispatchProgress`. `Packs.tsx`
// subscribes via `usePackTaskProgress`.

import { useEffect, useRef } from 'react';
import type { PackTaskProgress } from '../types';

type Handler = (progress: PackTaskProgress) => void;

const subscribers = new Set<Handler>();

export const packEvents = {
  onProgress: (h: Handler): (() => void) => {
    subscribers.add(h);
    return () => { subscribers.delete(h); };
  },
  dispatchProgress: (progress: PackTaskProgress): void => {
    subscribers.forEach((h) => { h(progress); });
  },
};

/** Subscribe to WS pushes for one `taskId`, filtering out every other
 *  in-flight task's frames. `onUpdate` fires on every matching WS frame —
 *  callers are responsible for the initial REST fetch (reconciliation) and
 *  any fallback polling while the socket is down. */
export function usePackTaskEvents(taskId: string | null, onUpdate: (progress: PackTaskProgress) => void): void {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!taskId) return;
    return packEvents.onProgress((progress) => {
      if (progress.taskId === taskId) onUpdateRef.current(progress);
    });
  }, [taskId]);
}
