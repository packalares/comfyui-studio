// WHY: enrich.ts emits `model:enriched` on the internal bus, but nothing
// forwards that to WS clients — so the UI never knows when a sidecar landed.
// previewHook.ts also subscribes to the same event, but it's a server-side
// side effect; this hook is the client-facing bridge.

import * as bus from '../../../lib/events.js';
import { emitChatEvent } from '../../chat/broadcaster.js';

export function registerEnrichmentWsHook(): void {
  bus.on('model:enriched', (payload) => {
    // Pass the raw payload through; UI subscribes by type and re-fetches the
    // affected catalog row (or page) when this arrives.
    emitChatEvent({ type: 'model:enriched', data: payload });
  });
}
