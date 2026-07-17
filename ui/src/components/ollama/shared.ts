// Shared types + helpers for the Ollama panel tabs (Installed / Library /
// HuggingFace). Extracted from OllamaModelsPanel.tsx so each tab card lives
// in its own ≤250-line file but they all agree on `PullState` and the
// installed-name normaliser.

import type { OllamaInstalledModel } from '../../services/comfyui';

export interface PullState {
  taskId: string;
  percent: number;
  status: string;
  completed?: number;
  total?: number;
  digest?: string;
}

export function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Normalise an Ollama model name for comparison. Ollama is case-sensitive
// on disk but most upstreams (HF, library catalog) advertise mixed-case
// identifiers; the actual `/api/tags` listing is typically lowercased.
// We also drop a trailing `:latest` so the bare name and the explicit
// latest-tag form compare equal.
export function normaliseOllamaName(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.endsWith(':latest')) s = s.slice(0, -':latest'.length);
  return s;
}

/** Case-insensitive, `:latest`-tolerant installed predicate.
 *
 *  Used by the HF tab: a model pulled via `ollama pull hf.co/Owner/Repo`
 *  shows up in `/api/tags` as `hf.co/owner/repo:latest` (or sometimes with
 *  a quant tag like `:Q4_K_M`). The Library tab still needs the strict
 *  `name:tag` check below — switching the tag dropdown to a variant the
 *  user does NOT have should re-enable the Pull button.
 *
 *  Returns the matching installed row when found (so the caller can show
 *  the actual tag — e.g. `Q4_K_M` — that landed), or null otherwise.
 */
export function findInstalledMatch(
  installed: OllamaInstalledModel[],
  ref: string,
): OllamaInstalledModel | null {
  const want = normaliseOllamaName(ref);
  for (const row of installed) {
    const got = normaliseOllamaName(row.name);
    if (got === want) return row;
    // Also accept the case where the user asked for the bare name but
    // Ollama tagged it (`hf.co/foo/bar` vs `hf.co/foo/bar:Q4_K_M`).
    if (got.startsWith(`${want}:`)) return row;
  }
  return null;
}
