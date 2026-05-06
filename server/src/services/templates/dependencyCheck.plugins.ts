// Plugin-side helpers for `dependencyCheck.ts`. Walks the workflow's
// class_types, resolves them via the Manager registry (`extractDepsAsync`),
// and crosses against installed plugin keys. Mirrors the legacy in-route
// logic; split out so the orchestrator stays under the file-size cap.

import { extractDepsWithPluginResolution } from './extractDepsAsync.js';
import {
  isPluginInstalled, getInstalledPluginKeys,
} from '../plugins/installedKeys.js';
import {
  canonicalize, dedupKey, normalizeRepoKey,
} from '../plugins/canonicalId.js';
import { findSubgraphDef } from '../workflow/proxyLabels.js';
import type { RequiredPluginInfo } from '../../contracts/generation.contract.js';

const repoMatchKey = normalizeRepoKey;

interface ClassTypeContext {
  /** Parent subgraph display name, or null when at top level. */
  subgraphName: string | null;
  /** Normalised aux_id / cnr_id values harvested from any node carrying
   *  this class_type — fallback when Manager's class_type resolver is
   *  unreachable. */
  auxKeys: Set<string>;
}

function harvestAuxKeys(node: Record<string, unknown>, into: Set<string>): void {
  const props = node.properties as Record<string, unknown> | undefined;
  if (!props) return;
  for (const fld of ['aux_id', 'cnr_id']) {
    const v = props[fld];
    if (typeof v === 'string' && v.length > 0) into.add(repoMatchKey(v));
  }
}

/**
 * Walk the workflow once and record per-class_type context: the parent
 * subgraph name AND any `aux_id`/`cnr_id` values found on nodes carrying
 * that class_type. Top-level nodes get `null` for `subgraphName`. Subgraph
 * wrappers themselves are NOT recorded (their `type` is a UUID, not a class).
 */
function collectClassTypeContexts(
  workflow: Record<string, unknown>,
): Map<string, ClassTypeContext> {
  const out = new Map<string, ClassTypeContext>();
  const ensure = (t: string, sg: string | null): ClassTypeContext => {
    let ctx = out.get(t);
    if (!ctx) {
      ctx = { subgraphName: sg, auxKeys: new Set() };
      out.set(t, ctx);
    } else if (ctx.subgraphName == null && sg != null) {
      ctx.subgraphName = sg;
    }
    return ctx;
  };
  const topNodes = (workflow.nodes as Array<Record<string, unknown>> | undefined) || [];
  for (const n of topNodes) {
    const t = (n.type as string | undefined) || (n.class_type as string | undefined);
    if (!t) continue;
    harvestAuxKeys(n, ensure(t, null).auxKeys);
  }
  for (const n of topNodes) {
    const props = n.properties as Record<string, unknown> | undefined;
    if (!props?.proxyWidgets && !n.subgraph) continue;
    const sg = findSubgraphDef(n, workflow);
    if (!sg) continue;
    const sgName = (sg.name as string | undefined) || (n.title as string | undefined) || null;
    const inner = (sg.nodes as Array<Record<string, unknown>> | undefined) || [];
    for (const ni of inner) {
      const t = (ni.type as string | undefined) || (ni.class_type as string | undefined);
      if (!t) continue;
      harvestAuxKeys(ni, ensure(t, sgName).auxKeys);
    }
  }
  return out;
}

const isBuiltinKey = (k: string): boolean =>
  k === 'comfy-core' || k === 'comfyui' || k === 'comfyanonymous/comfyui';

interface AuxByCanonicalEntry {
  repo: string;
  title: string;
  cnr_id?: string;
}
type Resolved = Awaited<ReturnType<typeof extractDepsWithPluginResolution>>;
type ResolvedMatches = Resolved['plugins'][number]['matches'];

const isSyntheticAuxRow = (
  classType: string, matches: ResolvedMatches,
): boolean => {
  if (matches.length !== 1) return false;
  return repoMatchKey(matches[0].repo) === repoMatchKey(classType);
};

function buildAuxByCanonical(resolved: Resolved): Map<string, AuxByCanonicalEntry> {
  const auxByCanonical = new Map<string, AuxByCanonicalEntry>();
  for (const r of resolved.plugins) {
    if (!isSyntheticAuxRow(r.classType, r.matches)) continue;
    const m = r.matches[0];
    const key = repoMatchKey(m.repo);
    const dkey = dedupKey(key);
    const existing = auxByCanonical.get(dkey);
    if (!existing) {
      auxByCanonical.set(dkey, { repo: key, title: m.title, cnr_id: m.cnr_id });
    } else if (key.includes('/') && !existing.repo.includes('/')) {
      // Promote the owner/repo form over a bare cnr_id — the slashed form is
      // the valid GitHub URL the install button can use.
      auxByCanonical.set(dkey, { repo: key, title: m.title, cnr_id: m.cnr_id });
    }
  }
  return auxByCanonical;
}

/**
 * Build the missing-plugin entry list. For each class_type the workflow
 * uses, look up its candidate plugin repos via Manager, then check whether
 * any are installed. Class types whose repos are all not-installed (or
 * have no Manager match at all) become missing-plugin entries. Built-in
 * `comfy-core` matches are filtered out — never installable as plugins.
 */
export async function buildPluginRequirementList(
  workflow: Record<string, unknown>,
): Promise<{ required: RequiredPluginInfo[]; missing: RequiredPluginInfo[] }> {
  const contexts = collectClassTypeContexts(workflow);
  const resolved = await extractDepsWithPluginResolution(workflow);
  const auxBag = new Set<string>();
  for (const r of resolved.plugins) for (const m of r.matches) auxBag.add(m.repo);
  for (const ctx of contexts.values()) for (const k of ctx.auxKeys) auxBag.add(k);
  await Promise.all(Array.from(auxBag).map((r) => canonicalize(r)));
  const installedKeys = getInstalledPluginKeys();
  const auxByCanonical = buildAuxByCanonical(resolved);

  const required: RequiredPluginInfo[] = [];
  const missing: RequiredPluginInfo[] = [];
  for (const r of resolved.plugins) {
    if (isSyntheticAuxRow(r.classType, r.matches)) continue;
    let realMatches = r.matches.filter((m) => !isBuiltinKey(repoMatchKey(m.repo)));
    if (r.matches.length > 0 && realMatches.length === 0) continue;

    const ctx = contexts.get(r.classType);
    const auxKeysReal = ctx
      ? Array.from(ctx.auxKeys).filter((k) => !isBuiltinKey(k))
      : [];
    if (realMatches.length === 0 && auxKeysReal.length > 0) {
      for (const auxKey of auxKeysReal) {
        const dkey = dedupKey(auxKey);
        const hit = auxByCanonical.get(dkey);
        if (hit) realMatches = [{ repo: hit.repo, title: hit.title, cnr_id: hit.cnr_id }];
        if (realMatches.length > 0) break;
      }
    }
    // Conservative skip: when neither Manager nor aux_id points at a real
    // plugin, we have zero evidence the class needs one — could be a core
    // node Manager hasn't catalogued, or a custom node with no metadata.
    // Not showing a false-positive missing-plugin entry beats surfacing
    // every unresolved class. Manager going offline is the most common
    // cause; this rule degrades gracefully.
    if (realMatches.length === 0
        && (!ctx || ctx.auxKeys.size === 0
            || Array.from(ctx.auxKeys).every(isBuiltinKey))) {
      continue;
    }
    const isInstalled = realMatches.length > 0
      && realMatches.every((m) => isPluginInstalled(m.repo, installedKeys));
    const subgraphName = ctx?.subgraphName ?? null;
    const entry: RequiredPluginInfo = {
      kind: 'plugin',
      classType: r.classType,
      subgraphName,
      repos: realMatches.map((m) => ({
        repo: repoMatchKey(m.repo), title: m.title, cnr_id: m.cnr_id,
      })),
      installed: isInstalled,
    };
    required.push(entry);
    if (!isInstalled) missing.push(entry);
  }
  return { required, missing };
}
