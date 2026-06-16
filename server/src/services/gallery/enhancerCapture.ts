// Transient capture of `PreviewAny`-probe outputs for in-flight prompts.
//
// During a generation, ComfyUI emits one `executed` WS event per output
// node. For each `__studio_enhanced_<sourceId>` probe injected by the
// prompt pipeline we get an event carrying `{ text: [<resolvedString>] }`.
// We stash those strings here keyed by `promptId` so the gallery row
// builder can stamp them onto the row when the corresponding SaveVideo /
// SaveImage executed event arrives (the two events fire independently
// from ComfyUI's side, often the probe lands first).
//
// Stored shape is `Map<promptId, Map<sourceNodeId, text>>` so a template
// with multiple `TextGenerate*` nodes (each routed to its own conditioner)
// records every output separately and the Details modal can render one row
// per enhancer instead of collapsing them.
//
// `appendHistoryEntry` separately falls back to walking `history.outputs`
// for the same prefix, so a late/missed WS event is non-fatal — the row
// gets the texts on the catch-up path.

import { sourceIdFromProbeKey } from '../workflow/prompt/enhancerProbe.js';

// promptId → sourceNodeId → resolved enhanced text
const buffers = new Map<string, Map<string, string>>();

/** Record one probe output. No-op when text is empty so we don't store
 *  blanks that would later look like "enhancement ran but produced nothing". */
export function recordEnhancement(
  promptId: string,
  sourceNodeId: string,
  text: string,
): void {
  if (!promptId || !sourceNodeId || !text) return;
  let inner = buffers.get(promptId);
  if (!inner) { inner = new Map(); buffers.set(promptId, inner); }
  inner.set(sourceNodeId, text);
}

/** Snapshot every captured enhancer for this prompt as a plain object
 *  keyed by source node id. Returns null when nothing was captured. */
export function peekAllEnhancements(promptId: string): Record<string, string> | null {
  const inner = buffers.get(promptId);
  if (!inner || inner.size === 0) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of inner) out[k] = v;
  return out;
}

/** Drop the buffer for a prompt once the gallery row has been persisted.
 *  Mirrors `clearPromptMeta` / `deleteSnapshot` in the lifecycle. */
export function clearEnhancement(promptId: string): void {
  buffers.delete(promptId);
}

/**
 * Walk a `/history.outputs` map for `__studio_enhanced_*` keys and return
 * every non-empty `text[0]` keyed by source node id. Used as the catch-up
 * path when the WS events were missed (slow client, restart between submit
 * and finish). Returns null when no probe output is found.
 */
export function enhancementsFromHistoryOutputs(
  outputs: Record<string, unknown> | undefined | null,
): Record<string, string> | null {
  if (!outputs || typeof outputs !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, payload] of Object.entries(outputs)) {
    const src = sourceIdFromProbeKey(key);
    if (src === null) continue;
    if (!payload || typeof payload !== 'object') continue;
    const text = (payload as { text?: unknown }).text;
    if (!Array.isArray(text)) continue;
    for (const v of text) {
      if (typeof v === 'string' && v !== '') { out[src] = v; break; }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge two enhancement records, preferring `primary` values on key
 * collision. Both args may be null. Returns null when both are empty.
 * Used so the WS-captured map (`primary`) survives even when the
 * history-walked fallback (`fallback`) covers a strict subset.
 */
export function mergeEnhancements(
  primary: Record<string, string> | null,
  fallback: Record<string, string> | null,
): Record<string, string> | null {
  if (!primary && !fallback) return null;
  const out: Record<string, string> = { ...(fallback ?? {}), ...(primary ?? {}) };
  return Object.keys(out).length > 0 ? out : null;
}
