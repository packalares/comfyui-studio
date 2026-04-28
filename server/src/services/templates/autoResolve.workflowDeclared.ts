// Auto-resolve steps that read a workflow's own `properties.models[]`
// declarations. Two shapes are supported:
//
//   Step 0a (`stepHfRepo`):   `{ name, hfRepo: "owner/repo", directory }`
//                             - whole-HF-repo download via huggingface-cli.
//   Step 0b (`stepWorkflowDeclaredUrl`):
//                             `{ name, url: "https://...", directory }`
//                             - single-file URL, runs through HF or civitai
//                               resolver to grab size + suggested folder.
//
// Both walk top-level + subgraph-internal nodes so a model declared inside
// a nested subgraph is still picked up.
//
// Pulled out of `autoResolveModels.ts` so that file stays under the 250-line
// per-file cap (it was already a baseline structure offender pre-split).

import { resolveHuggingfaceUrl, type ResolvedModel } from '../models/resolveHuggingface.js';
import { resolveCivitaiUrl } from '../models/resolveCivitai.js';
import type { AutoResolvedModel } from './importStaging.js';

function sameFile(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

// Walk the workflow's top-level `nodes[]` plus every subgraph's `nodes[]`.
// Yields each `properties.models[]` entry that's a valid object — caller
// filters by name + relevant fields.
function* iterModelEntries(
  workflow: Record<string, unknown> | undefined,
): Iterable<Record<string, unknown>> {
  if (!workflow) return;
  const nodes = (workflow.nodes as Array<Record<string, unknown>> | undefined) || [];
  const inner: Array<Record<string, unknown>> = [];
  const defs = (workflow.definitions as Record<string, unknown> | undefined)?.subgraphs;
  if (Array.isArray(defs)) {
    for (const sg of defs as Array<Record<string, unknown>>) {
      const sgNodes = (sg?.nodes as Array<Record<string, unknown>> | undefined) || [];
      inner.push(...sgNodes);
    }
  }
  for (const node of [...nodes, ...inner]) {
    const props = node.properties as Record<string, unknown> | undefined;
    const arr = (props?.models as Array<Record<string, unknown>> | undefined) || [];
    for (const raw of arr) {
      if (raw && typeof raw === 'object') yield raw;
    }
  }
}

export function stepHfRepo(
  filename: string, workflow: Record<string, unknown>,
): AutoResolvedModel | null {
  for (const raw of iterModelEntries(workflow)) {
    const name = raw.name as string | undefined;
    const hfRepo = raw.hfRepo as string | undefined;
    const dir = raw.directory as string | undefined;
    if (name === filename && hfRepo) {
      const out: AutoResolvedModel = {
        source: 'hfRepo',
        downloadUrl: '',
        hfRepo,
        confidence: 'high',
      };
      if (dir) out.suggestedFolder = dir;
      return out;
    }
  }
  return null;
}

export interface UrlResolutionDeps {
  upsertCatalogFromAuto: (
    filename: string, resolved: ResolvedModel, loaderClass?: string,
  ) => void;
  toAutoResolved: (
    source: 'markdown', resolved: ResolvedModel, loaderClass?: string,
  ) => AutoResolvedModel;
}

export async function stepWorkflowDeclaredUrl(
  filename: string,
  workflow: Record<string, unknown>,
  loaderClass: string | undefined,
  deps: UrlResolutionDeps,
): Promise<AutoResolvedModel | null> {
  for (const raw of iterModelEntries(workflow)) {
    const name = raw.name as string | undefined;
    const url = raw.url as string | undefined;
    if (name !== filename || !url) continue;
    let resolved: ResolvedModel | null = null;
    try {
      const host = new URL(url).hostname;
      if (/huggingface\.co$/i.test(host)) resolved = await resolveHuggingfaceUrl(url);
      else if (/civitai\.com$/i.test(host)) resolved = await resolveCivitaiUrl(url);
    } catch { resolved = null; }
    if (!resolved || !sameFile(resolved.fileName, filename)) continue;
    deps.upsertCatalogFromAuto(filename, resolved, loaderClass);
    return deps.toAutoResolved('markdown', resolved, loaderClass);
  }
  return null;
}
