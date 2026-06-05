// Converts a SseRouteSpec's event map into an OpenAPI 3.1 schema
// representing the `text/event-stream` response body.
//
// SSE wire format per event:
//   event: <name>\n
//   data:  <json payload>\n
//   id:    <optional id>\n
//   \n
//
// The schema emits a `oneOf` over all declared event shapes, where each
// variant is an object with `event` (literal), `data` (payload schema), and
// optional `id`.

import { z } from 'zod';
import type { SseEventMap, SseRouteSpec } from '../../contracts/sse.contract.js';

/** Build the Zod schema for one SSE event frame. */
function eventFrameSchema(name: string, payloadSchema: z.ZodType): z.ZodObject {
  return z.object({
    event: z.literal(name),
    data: payloadSchema,
    id: z.string().optional(),
  });
}

/**
 * Produces a `z.discriminatedUnion`-like schema over the declared SSE events.
 * Because the frames have a literal `event` field this is representable as a
 * Zod union; the OpenAPI generator will emit `oneOf` for it.
 *
 * If the spec declares zero events (pathological), returns `z.unknown()`.
 */
export function buildSseUnionSchema(spec: SseRouteSpec<SseEventMap>): z.ZodType {
  const entries = Object.entries(spec.events);
  if (entries.length === 0) return z.unknown();
  const [firstName, firstPayload] = entries[0];
  if (entries.length === 1) {
    return eventFrameSchema(firstName, firstPayload);
  }
  const schemas = entries.map(([name, payload]) => eventFrameSchema(name, payload));
  // z.union requires at least 2 types; we checked length >= 2 above.
  return z.union([
    schemas[0] as z.ZodObject,
    schemas[1] as z.ZodObject,
    ...schemas.slice(2),
  ]);
}
