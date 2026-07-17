// Wave 8: Disambiguate multiple on-disk candidates for the same model
// filename by reading their sidecar metadata and filtering on base_model.

import { readSidecar } from '../enrichment/sidecar.js';
import type { BaseModelMeta } from '../enrichment/types.js';

export interface Candidate {
  filename: string;
  save_path: string;
  abs_path: string;
  sha256?: string;
  base_model?: string;
  enrichment?: BaseModelMeta;
}

export interface DisambiguateResult {
  resolved: Candidate | null;
  remaining: Candidate[];
}

/**
 * Attempt to narrow multiple candidates to a single match using sidecar
 * `base_model` metadata.
 *
 * Algorithm:
 *   1. Read the sidecar for each candidate and populate `enrichment` +
 *      `base_model` (sidecar wins over any pre-populated value).
 *   2. If `baseModelHint` is provided, filter to candidates whose
 *      `base_model` contains the hint (case-insensitive substring).
 *      - Exactly 1 match  → resolved.
 *      - 0 or >1 matches  → remaining = all original candidates, resolved = null.
 *   3. If no hint → resolved = null, remaining = all candidates.
 */
export function disambiguate(
  candidates: Candidate[],
  baseModelHint: string | null,
): DisambiguateResult {
  if (candidates.length === 0) {
    return { resolved: null, remaining: [] };
  }

  // Enrich candidates with sidecar data.
  const enriched: Candidate[] = candidates.map((c) => {
    const sidecar = readSidecar(c.abs_path);
    if (!sidecar) return { ...c };
    return {
      ...c,
      enrichment: sidecar,
      base_model: sidecar.base_model ?? c.base_model,
      sha256: sidecar.sha256 ?? c.sha256,
    };
  });

  if (!baseModelHint) {
    return { resolved: null, remaining: enriched };
  }

  const hintLower = baseModelHint.toLowerCase();
  const matched = enriched.filter(
    (c) => c.base_model && c.base_model.toLowerCase().includes(hintLower),
  );

  if (matched.length === 1) {
    return { resolved: matched[0], remaining: enriched };
  }

  // 0 or multiple matches — cannot auto-resolve.
  return { resolved: null, remaining: enriched };
}
