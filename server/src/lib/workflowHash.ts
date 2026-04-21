// Canonical hash of a ComfyUI API-format workflow ("apiPrompt").
//
// Used by the cache-hit resolver: when ComfyUI reports `execution_cached`
// covering every node, it writes no outputs to history and the prompt_id
// the client just submitted is useless. Hashing the canonical prompt lets
// us find the gallery row from the ORIGINAL (uncached) run that produced
// the same outputs, and surface those to the UI.
//
// Canonicalization rules:
//   - Recursively sort object keys so JSON.stringify produces byte-stable
//     output regardless of insertion order.
//   - Drop `_meta` at every level — ComfyUI stores UI hints (node titles
//     etc.) there; the same logical prompt can have different `_meta` after
//     renaming a node.
//   - Leave arrays ordered (they're semantically meaningful — e.g. inputs
//     `[nodeId, slot]`).
//
// Returns a short hex string (16 chars, 64 bits of sha1 prefix). That's
// plenty to distinguish workflows in a single user's history without
// bloating the row.

import { createHash } from 'crypto';

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => k !== '_meta')
    .map(([k, v]) => [k, canonicalize(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

export function workflowHash(apiPrompt: unknown): string {
  if (!apiPrompt || typeof apiPrompt !== 'object') return '';
  const canonical = canonicalize(apiPrompt);
  const json = JSON.stringify(canonical);
  return createHash('sha1').update(json).digest('hex').slice(0, 16);
}

/** Detect a full cache-hit from a ComfyUI history entry's `status.messages` array. */
export function isFullCacheHit(
  statusMessages: unknown,
  apiPrompt: Record<string, unknown> | null,
): boolean {
  if (!Array.isArray(statusMessages) || !apiPrompt) return false;
  const cached = statusMessages.find(
    (m): m is [string, { nodes?: string[] }] =>
      Array.isArray(m) && m[0] === 'execution_cached' && typeof m[1] === 'object',
  );
  if (!cached) return false;
  const cachedNodes = Array.isArray(cached[1]?.nodes) ? cached[1].nodes : [];
  const workflowNodes = Object.keys(apiPrompt);
  if (workflowNodes.length === 0) return false;
  // Every node in the workflow must appear in execution_cached for this to
  // be a true no-op cache hit. Partial cache hits (some nodes re-run) still
  // produce real outputs and go through the normal path.
  const cachedSet = new Set(cachedNodes);
  return workflowNodes.every(n => cachedSet.has(n));
}
