// Wrapper-aware LiteGraph detection.
//
// Imports of user workflows arrive in two shapes:
//   1. Raw LiteGraph: `{ nodes, links, extra, ... }` — the format ComfyUI's
//      "Save (API Format)" / "Save" buttons emit.
//   2. TemplateData wrapper: `{ name, title, description, tags, thumbnail,
//      workflow: { nodes, ... } }` — the shape Studio's own bundled workflow
//      JSON files use, and the shape we encourage authors to publish so a
//      single file carries title + description + tags + thumbnail alongside
//      the graph.
//
// `extractLitegraph` accepts both and returns the inner LiteGraph plus any
// metadata defaults the wrapper carried. Callers pass the inner workflow to
// `stageFromJson` / `entryToWorkflow` and use the defaults to populate
// `defaultTitle` / `defaultDescription` / `defaultTags` / `defaultThumbnail`
// on staging — without re-implementing wrapper detection at every site.

import { looksLikeLitegraph } from './importStaging.js';

export interface ExtractedLitegraphDefaults {
  defaultTitle?: string;
  defaultDescription?: string;
  defaultTags?: string[];
  defaultThumbnail?: string;
}

export interface ExtractedLitegraph {
  workflow: Record<string, unknown>;
  defaults: ExtractedLitegraphDefaults;
}

export function extractLitegraph(value: unknown): ExtractedLitegraph | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // Wrapper shape: object whose `workflow` field is itself a LiteGraph.
  // We only inspect wrapper-known fields (title/description/tags/thumbnail) —
  // every other top-level key is ignored so a future wrapper field rev never
  // bleeds into the staging defaults.
  if (obj.workflow && typeof obj.workflow === 'object' && looksLikeLitegraph(obj.workflow)) {
    const defaults: ExtractedLitegraphDefaults = {};
    if (typeof obj.title === 'string') defaults.defaultTitle = obj.title;
    if (typeof obj.description === 'string') defaults.defaultDescription = obj.description;
    if (Array.isArray(obj.tags)) {
      defaults.defaultTags = obj.tags.filter((t): t is string => typeof t === 'string');
    }
    if (Array.isArray(obj.thumbnail) && typeof obj.thumbnail[0] === 'string') {
      defaults.defaultThumbnail = obj.thumbnail[0];
    }
    return { workflow: obj.workflow as Record<string, unknown>, defaults };
  }
  // Raw LiteGraph shape — preserve existing behaviour, no defaults extracted.
  if (looksLikeLitegraph(value)) return { workflow: obj, defaults: {} };
  return null;
}
