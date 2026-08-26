// Extract HuggingFace + CivitAI model URLs from a workflow's MarkdownNote /
// Note nodes.
//
// Many community workflows embed "where to get the models" links inside a
// MarkdownNote so end-users can follow along. We grep these strings so the
// Wave E review step can pre-fill the "Resolve via URL" affordance when a
// referenced filename matches a scanned link — cutting the manual copy/paste
// step entirely. Non-HF/Civit URLs are discarded: we intentionally refuse
// to auto-trust arbitrary CDNs until we grow a per-host resolver for them.

const HOST_RE = /https?:\/\/(www\.)?(huggingface\.co|civitai\.com)\b[^\s)<>"']*/gi;

function pushMatches(out: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) return;
  // Global regex: every iteration yields the next match; reset between
  // values to avoid sticky lastIndex between different strings.
  HOST_RE.lastIndex = 0;
  for (const m of value.matchAll(HOST_RE)) {
    if (typeof m[0] === 'string') out.add(stripTrailingPunct(m[0]));
  }
}

/** URLs inside markdown sometimes end with `.` / `,` / `)` / `]`. Trimmed with
 *  a linear scan (no backtracking regex). */
const TRAILING_PUNCT = new Set([')', '.', ',', ';', ':', '!', '?', ']']);
function stripTrailingPunct(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCT.has(url[end - 1])) end--;
  return url.slice(0, end);
}

function isNoteClass(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value === 'MarkdownNote' || value === 'Note';
}

function scanNode(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  const isNote = isNoteClass(n.class_type) || isNoteClass(n.type);
  if (!isNote) return;
  if (Array.isArray(n.widgets_values)) {
    for (const v of n.widgets_values) pushMatches(out, v);
  }
  if (n.inputs && typeof n.inputs === 'object') {
    for (const v of Object.values(n.inputs as Record<string, unknown>)) pushMatches(out, v);
  }
}

/**
 * Return every HuggingFace / CivitAI URL found inside MarkdownNote / Note
 * nodes of a workflow. Works on both the API format (map keyed by id) and
 * the UI/LiteGraph format (`{nodes: [...]}`). Dedupes, returns sorted.
 */
export function extractModelUrlsFromWorkflow(workflowJson: unknown): string[] {
  const out = new Set<string>();
  if (!workflowJson || typeof workflowJson !== 'object') return [];
  const wf = workflowJson as Record<string, unknown>;

  // API format: the root is a dict keyed by node id. Every entry has
  // `class_type` plus `inputs` / `widgets_values`.
  for (const key of Object.keys(wf)) {
    const entry = wf[key];
    if (!entry || typeof entry !== 'object') continue;
    if ('class_type' in (entry as Record<string, unknown>)) {
      scanNode(entry, out);
    }
  }

  // UI/LiteGraph format: `{ nodes: [...] }`, optionally with nested
  // subgraphs. We recurse any nested `subgraph.nodes` arrays so notes
  // embedded inside a subgraph aren't missed.
  const visit = (nodes: unknown[]): void => {
    for (const n of nodes) {
      scanNode(n, out);
      if (n && typeof n === 'object') {
        const sub = (n as { subgraph?: { nodes?: unknown } }).subgraph;
        if (sub && Array.isArray(sub.nodes)) visit(sub.nodes);
      }
    }
  };
  if (Array.isArray(wf.nodes)) visit(wf.nodes);
  // Definitions (subgraphs block) is also scanned for completeness.
  const defs = wf.definitions;
  if (defs && typeof defs === 'object') {
    const subgraphs = (defs as { subgraphs?: unknown }).subgraphs;
    if (Array.isArray(subgraphs)) {
      for (const sg of subgraphs) {
        if (sg && typeof sg === 'object') {
          const nested = (sg as { nodes?: unknown }).nodes;
          if (Array.isArray(nested)) visit(nested);
        }
      }
    }
  }

  return Array.from(out).sort();
}
