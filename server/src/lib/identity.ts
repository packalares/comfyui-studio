// Download-identity matcher.
//
// Downloads can be looked up by either `modelName` or `filename`, and legacy
// clients sometimes pass one into the other's slot. The matcher is lenient
// on purpose: we accept cross-matches so the dedup logic catches every
// real-world duplicate.

export interface Identity {
  modelName?: string;
  filename?: string;
}

/**
 * True when `entry` represents the same download as `id`, under either of
 * the two fields. Empty queries never match anything (avoids grabbing the
 * first active download indiscriminately).
 */
export function matchesIdentity(entry: Identity, id: Identity): boolean {
  if (!id.filename && !id.modelName) return false;
  if (id.filename) {
    if (entry.filename === id.filename) return true;
    if (entry.modelName === id.filename) return true;
  }
  if (id.modelName) {
    if (entry.modelName === id.modelName) return true;
    if (entry.filename === id.modelName) return true;
  }
  return false;
}
