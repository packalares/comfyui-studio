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
  // Easy-mode metadata harvested from the outer wrapper. These ride through
  // staging on the per-workflow StagedWorkflowEntry and land on the saved
  // TemplateData verbatim via importCommit. Forwarded as opaque shapes — the
  // saveUserWorkflow typing enforces the real structure.
  defaultStudioBuilder?: string;
  defaultStudioModes?: Record<string, unknown>;
  defaultStudioInputMap?: Record<string, string>;
  defaultPromptEnhancer?: Record<string, unknown>;
  defaultPromptToggles?: Record<string, Record<string, string>>;
}

export interface ExtractedLitegraph {
  workflow: Record<string, unknown>;
  defaults: ExtractedLitegraphDefaults;
}

export function extractLitegraph(value: unknown): ExtractedLitegraph | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // Wrapper shape: object whose `workflow` field is itself a LiteGraph.
  // This is the ONLY shape that carries TemplateData metadata (title,
  // Easy-mode fields, etc.) — Easy-mode metadata bolted onto a raw
  // LiteGraph is unsupported on purpose: one shape, one source of truth.
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
    if (typeof obj.studioBuilder === 'string') {
      defaults.defaultStudioBuilder = obj.studioBuilder;
    }
    if (obj.studioModes && typeof obj.studioModes === 'object' && !Array.isArray(obj.studioModes)) {
      defaults.defaultStudioModes = obj.studioModes as Record<string, unknown>;
    }
    if (obj.studioInputMap && typeof obj.studioInputMap === 'object' && !Array.isArray(obj.studioInputMap)) {
      const m = obj.studioInputMap as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'string') cleaned[k] = v;
      }
      defaults.defaultStudioInputMap = cleaned;
    }
    if (obj.promptEnhancer && typeof obj.promptEnhancer === 'object' && !Array.isArray(obj.promptEnhancer)) {
      defaults.defaultPromptEnhancer = obj.promptEnhancer as Record<string, unknown>;
    }
    if (obj.prompt_toggles && typeof obj.prompt_toggles === 'object' && !Array.isArray(obj.prompt_toggles)) {
      defaults.defaultPromptToggles = obj.prompt_toggles as Record<string, Record<string, string>>;
    }
    return { workflow: obj.workflow as Record<string, unknown>, defaults };
  }
  // Raw LiteGraph shape — accepted (so ComfyUI's "Save (API)" export still
  // imports) but no defaults extracted. Authors who need Easy-mode metadata
  // must use the TemplateData wrapper shape above.
  if (looksLikeLitegraph(value)) return { workflow: obj, defaults: {} };
  return null;
}
