// Fast Groups Muter (rgthree) → mute-list resolver.
//
// At submit time, if the active studioMode declares group-aware muting via
// `fgmNodeId` and/or `enableGroups`, this helper walks the workflow's groups
// + nodes and returns the top-level node ids that should be muted (i.e. nodes
// in groups NOT listed as `enableGroups`).
//
// The result is appended to `studioModes[mode].mute` and processed by the
// existing delete-from-apiPrompt mute pipeline in generate.routes.ts — no new
// validation path; FGM-derived mutes share the same enforcement as explicit
// node-id mutes.
//
// Trigger semantics:
//   - No FGM node found in workflow → skip silently (return []).
//   - `enableGroups` omitted on the mode → default to `[mode]`, i.e. enable
//     the single group whose title equals the mode key.
//   - `fgmNodeId` omitted → auto-pick the first FGM-class node found.

import { FGM_CLASS_TYPE } from './fgmConst.js';

interface LiteGraphNode {
  id: number;
  type?: string;
  pos?: [number, number];
  size?: [number, number] | { 0: number; 1: number };
}

interface LiteGraphGroup {
  title?: string;
  bounding?: [number, number, number, number];
}

interface LiteGraphWorkflow {
  nodes?: LiteGraphNode[];
  groups?: LiteGraphGroup[];
}

interface FgmModeConfig {
  fgmNodeId?: number;
  enableGroups?: string[];
}

/**
 * Compute the node ids to mute for the active mode based on FGM/group config.
 *
 * @param workflow  LiteGraph-shape workflow (has `nodes` + `groups`).
 * @param mode      Active mode key (used as the default group name when
 *                  `enableGroups` is omitted).
 * @param modeConfig  Per-mode config from `studioModes[mode]`.
 * @returns         Top-level node ids to mute. Empty array if no FGM in the
 *                  workflow, no groups defined, or all groups are enabled.
 */
export function computeFgmMutedNodes(
  workflow: LiteGraphWorkflow,
  mode: string,
  modeConfig: FgmModeConfig,
): number[] {
  const groups = workflow.groups;
  const nodes = workflow.nodes;
  if (!Array.isArray(groups) || groups.length === 0) return [];
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  // ---- Locate the FGM node (or bail) ----
  const fgm = modeConfig.fgmNodeId !== undefined
    ? nodes.find((n) => n.id === modeConfig.fgmNodeId)
    : nodes.find((n) => n.type === FGM_CLASS_TYPE);
  if (!fgm) return [];

  // ---- Resolve which groups should stay active ----
  const enable = new Set(modeConfig.enableGroups ?? [mode]);

  // ---- For every disabled group, collect its inner nodes ----
  const muted: number[] = [];
  for (const group of groups) {
    const title = group.title;
    if (!title || enable.has(title)) continue;
    const bounding = group.bounding;
    if (!bounding || bounding.length < 4) continue;
    const [gx, gy, gw, gh] = bounding;
    for (const node of nodes) {
      if (!node.pos || node.pos.length < 2) continue;
      // Don't mute the FGM itself — even when its own group is disabled,
      // keeping the muter alive is safer (the existing mute pipeline drops
      // unreachable references anyway).
      if (node.id === fgm.id) continue;
      const [nx, ny] = node.pos;
      // Use node center for "inside group" check — robust to nodes that
      // poke slightly outside a group's box on the edges.
      const sizeArr: [number, number] | undefined = Array.isArray(node.size)
        ? node.size
        : (node.size ? [node.size[0], node.size[1]] : undefined);
      const nw = sizeArr?.[0] ?? 200;
      const nh = sizeArr?.[1] ?? 80;
      const cx = nx + nw / 2;
      const cy = ny + nh / 2;
      if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) {
        muted.push(node.id);
      }
    }
  }
  return muted;
}
