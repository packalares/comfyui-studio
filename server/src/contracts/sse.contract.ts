// Canonical Server-Sent Events wire contract.
//
// Every Studio SSE endpoint exposes a typed `SseRouteSpec` that declares the
// allowed event names and the Zod payload schema for each one. The runtime
// helper in `lib/sse.ts` validates every emit against the spec; OpenAPI emit
// (Wave 4) reads the same spec to publish the stream's event union.
//
// Wire frame for one event:
//   event: <name>\n
//   data:  <single-line JSON>\n
//   id:    <optional monotonic id>\n
//   \n
// Heartbeats use the SSE comment form (`: keep-alive\n\n`) so they never
// surface as events on the client.

import { z } from 'zod';

// Generic envelope — useful for callers that want to assert "this is an SSE
// event of some shape" without knowing the specific stream. Route specs
// constrain `event` and `data` further via `SseRouteSpec`.
export const SseEventSchema = z.object({
  event: z.string().min(1),
  data: z.unknown(),
  id: z.string().optional(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;

// A map from event name → Zod schema for that event's `data` payload.
export type SseEventMap = Record<string, z.ZodType>;

// Declared shape of one SSE stream. The `events` map is exhaustive (every
// event the route can emit must appear). `terminalEvents` is the subset of
// event names whose emit closes the stream — the helper uses this to wire
// `emitTerminal` and to let OpenAPI emit mark the stream's success / error
// branches. The `as const` tuple preserves the literal union for narrowing.
export interface SseRouteSpec<EventMap extends SseEventMap> {
  events: EventMap;
  terminalEvents: ReadonlyArray<keyof EventMap & string>;
}

// Convenience constructor — narrows the `terminalEvents` tuple to the literal
// union of declared event names so consumers get full key-level autocomplete.
// Validates at module-load time that every terminal name is actually declared
// in `events` (catches typos before the first request).
export function defineSseRouteSpec<EventMap extends SseEventMap>(
  spec: SseRouteSpec<EventMap>,
): SseRouteSpec<EventMap> {
  for (const name of spec.terminalEvents) {
    if (!(name in spec.events)) {
      throw new Error(`sse.contract: terminalEvents includes "${name}" which is not declared in events`);
    }
  }
  return spec;
}

// Public type for an emitted event narrowed to one stream's declared map.
// Wave 4 OpenAPI emit consumes this to publish the per-event payload union.
export type SseEmittedEvent<EventMap extends SseEventMap> = {
  [K in keyof EventMap]: { event: K; data: z.infer<EventMap[K]>; id?: string };
}[keyof EventMap];
