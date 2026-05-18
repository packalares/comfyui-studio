// Mode-detection: inspect a workflow's top-level nodes and identify either
// a mutually-exclusive subgraph cluster (→ mode-select form field) or
// independent bypassed nodes (→ bypass-toggle form fields).
//
// Why here and not in the general formFieldPlan? These fields are structurally
// distinct from widget/primitive fields — they control graph topology, not
// individual widget values. Keeping them in their own module lets the
// orchestrator in index.ts prepend/append them without tangling the
// existing merge/deduplicate pipeline.

import { findSubgraphDef } from '../../workflow/proxyLabels.js';
import { TEXT_PLUMBING_CLASS_TYPES } from '../../workflow/constants.js';

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

export interface ModeSelectOption {
  /** Stable slug identifying this subgraph instance (string of the node id). */
  value: string;
  /** Human-readable label derived from the subgraph definition's name field. */
  label: string;
  /** Top-level node ids to set mode=4 when this option is active. */
  bypassNodes: number[];
}

export interface ModeSelectField {
  type: 'mode-select';
  id: 'mode';
  label: 'Mode';
  required: false;
  default: string;
  options: ModeSelectOption[];
}

export interface BypassToggleField {
  type: 'bypass-toggle';
  id: string;
  label: string;
  required: false;
  default: false;
  bindNodeId: string;
}

export interface ModeDetectResult {
  modeSelect: ModeSelectField | null;
  bypassToggles: BypassToggleField[];
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function isSubgraphInstance(node: Record<string, unknown>): boolean {
  const props = node.properties as Record<string, unknown> | undefined;
  return !!(props?.proxyWidgets);
}

// A node is "active" when mode is 0 or undefined (ComfyUI treats missing
// mode as 0 — same as the native editor's default).
function isActive(node: Record<string, unknown>): boolean {
  const mode = node.mode as number | undefined;
  return mode === 0 || mode === undefined;
}

function isBypassed(node: Record<string, unknown>): boolean {
  return (node.mode as number | undefined) === 4;
}

// Derive a short prefix that all strings in the set share, so we can strip
// it from labels to produce compact option text (e.g. "OneReward Image
// Inpainting" / "OneReward Image Outpainting" → "Inpainting" / "Outpainting").
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, prefix.length - 1);
      if (prefix === '') return '';
    }
  }
  // Walk back to the last space so we don't cut mid-word.
  const spaceIdx = prefix.lastIndexOf(' ');
  prefix = spaceIdx > 0 ? prefix.slice(0, spaceIdx + 1) : prefix;
  // Walk back further so we never end inside an unbalanced bracket group —
  // otherwise the stripped suffix has an orphan closing bracket (e.g.
  // "Image Edit (Qwen 2509)" / "Image Edit (Qwen 2509 Raw Latent)" would
  // strip to "2509)" / "2509 Raw Latent)"). Re-walk to the previous space
  // after each shrink so we still cut on word boundaries.
  while (prefix.length > 0 && !bracketsBalanced(prefix)) {
    const trimmed = prefix.slice(0, prefix.length - 1);
    const spaceBefore = trimmed.lastIndexOf(' ');
    prefix = spaceBefore > 0 ? trimmed.slice(0, spaceBefore + 1) : '';
  }
  return prefix;
}

function bracketsBalanced(s: string): boolean {
  let round = 0;
  let square = 0;
  for (const ch of s) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }
  return round === 0 && square === 0;
}

function subgraphName(
  node: Record<string, unknown>,
  workflow: Record<string, unknown>,
): string {
  const sg = findSubgraphDef(node, workflow);
  if (sg?.name && typeof sg.name === 'string') return sg.name;
  // Fall back to the node's type string (the subgraph UUID) or id.
  return (node.type as string | undefined) ?? String(node.id ?? '');
}

// -----------------------------------------------------------------------
// Cluster detection → mode-select
// -----------------------------------------------------------------------

function detectModeSelect(
  topNodes: Array<Record<string, unknown>>,
  workflow: Record<string, unknown>,
): ModeSelectField | null {
  const subgraphNodes = topNodes.filter(isSubgraphInstance);
  if (subgraphNodes.length < 2) return null;

  // All must be either mode=0/undefined (active) or mode=4 (bypassed).
  // A node at mode=2 (muted) or other is not part of a clean mutual-exclusion
  // cluster — bail out for safety.
  const allClean = subgraphNodes.every(n => isActive(n) || isBypassed(n));
  if (!allClean) return null;

  const activeOnes = subgraphNodes.filter(isActive);
  const bypassedOnes = subgraphNodes.filter(isBypassed);

  // Mutual-exclusion rule: exactly one active, rest bypassed.
  if (activeOnes.length !== 1) return null;
  if (bypassedOnes.length < 1) return null;

  // Derive names and strip common prefix so options are compact.
  const rawNames = subgraphNodes.map(n => subgraphName(n, workflow));
  const prefix = longestCommonPrefix(rawNames);
  const stripped = rawNames.map(n => n.slice(prefix.length).trim());
  // If stripping empties any name, fall back to raw names.
  const useStripped = stripped.every(s => s.length > 0);
  let labels = useStripped ? stripped : rawNames;

  // Disambiguate collisions. Some workflow authors give multiple subgraph
  // definitions the exact same name (e.g. `image_flux2_klein_image_edit_4b_
  // distilled` ships two "Image Edit (Flux.2 Klein 4B Distilled)" subgraphs
  // — one single-ref, one dual-ref — both labeled identically). Without this
  // fixup the dropdown shows two visually identical options. Append the
  // instance node id only to the colliding entries so unique entries stay
  // clean.
  const counts: Record<string, number> = {};
  for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
  labels = labels.map((l, i) =>
    counts[l] > 1 ? `${l} (#${subgraphNodes[i].id})` : l,
  );

  const activeNode = activeOnes[0];
  const activeSlug = String(activeNode.id);

  const options: ModeSelectOption[] = subgraphNodes.map((n, i) => ({
    value: String(n.id),
    label: labels[i],
    // When this option is active, every OTHER subgraph node in the cluster
    // must be bypassed.
    bypassNodes: subgraphNodes
      .filter(other => other !== n)
      .map(other => other.id as number),
  }));

  return {
    type: 'mode-select',
    id: 'mode',
    label: 'Mode',
    required: false,
    default: activeSlug,
    options,
  };
}

// -----------------------------------------------------------------------
// Independent bypass-toggle detection
// -----------------------------------------------------------------------

function detectBypassToggles(
  topNodes: Array<Record<string, unknown>>,
  workflow: Record<string, unknown>,
  _clusterNodeIds: Set<number>,
): BypassToggleField[] {
  const toggles: BypassToggleField[] = [];

  // Top-level bypassed nodes are NOT surfaced as toggles. In real workflows
  // they almost always represent a whole skipped pipeline (template ships
  // with inpaint active + outpaint bypassed, or similar). Emitting one
  // toggle per bypassed loader/sampler/saver floods the form with 20+
  // useless switches whose individual flipping would just break the graph.
  // The proper way to switch between pipelines is the mode-select cluster
  // (feature 4); when a template uses plain top-level nodes instead of
  // subgraph wrappers, we currently don't auto-detect that — and that's a
  // tractable follow-up, not a reason to spam the form here.
  //
  // What IS surfaced: bypassed nodes INSIDE an active subgraph. That's the
  // canonical "optional feature" pattern — e.g. OneReward's removal LoRA,
  // shipped bypassed inside the active inpaint subgraph, ready to be opted
  // into without flipping the whole pipeline.
  for (const topNode of topNodes) {
    if (!isSubgraphInstance(topNode)) continue;
    if (!isActive(topNode)) continue;
    const sg = findSubgraphDef(topNode, workflow);
    if (!sg) continue;
    const innerNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
    for (const inner of innerNodes) {
      if (!isBypassed(inner)) continue;
      const type = (inner.type as string | undefined) ?? '';
      if (TEXT_PLUMBING_CLASS_TYPES.has(type)) continue;
      // Compound id matching the flattener convention: <wrapperNodeId>:<innerNodeId>
      const compoundId = `${String(topNode.id)}:${String(inner.id)}`;
      toggles.push(makeToggle(compoundId, inner));
    }
  }

  return toggles;
}

function makeToggle(
  nodeId: string,
  node: Record<string, unknown>,
): BypassToggleField {
  // Prefer the author-set title; fall back to the node's type string.
  const rawLabel = (node.title as string | undefined)
    ?? (node.type as string | undefined)
    ?? nodeId;
  // Prepend "Enable" so the toggle reads as an opt-in (shipped as mode=4 → default off).
  const label = `Enable ${rawLabel}`;
  return {
    type: 'bypass-toggle',
    id: `toggle_${nodeId}`,
    label,
    required: false,
    default: false,
    bindNodeId: nodeId,
  };
}

// -----------------------------------------------------------------------
// Main export
// -----------------------------------------------------------------------

export function detectModeFields(
  workflow: Record<string, unknown>,
): ModeDetectResult {
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;

  const modeSelect = detectModeSelect(topNodes, workflow);

  // Build set of node ids that belong to the mutual-exclusion cluster so
  // bypass-toggle detection can skip them.
  const clusterNodeIds = new Set<number>();
  if (modeSelect) {
    const subgraphNodes = topNodes.filter(isSubgraphInstance);
    for (const n of subgraphNodes) {
      if (typeof n.id === 'number') clusterNodeIds.add(n.id);
    }
  }

  const bypassToggles = detectBypassToggles(topNodes, workflow, clusterNodeIds);

  return { modeSelect, bypassToggles };
}
