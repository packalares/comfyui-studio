// Shared template data shapes for the templates service split.

export interface FormInputData {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'image' | 'audio' | 'video' | 'number' | 'slider' | 'select' | 'toggle'
    | 'mode-select' | 'bypass-toggle';
  required: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /**
   * options is used both by 'select' (simple label/value pairs) and by
   * 'mode-select' (each option also carries a bypassNodes list so the submit
   * path knows which top-level nodes to set mode=4 when that option is active).
   */
  options?: Array<{ label: string; value: string; bypassNodes?: number[] }>;
  /** May be a compound flat id like `"424:269"` when the bound loader lives
   * inside a subgraph instance; legacy top-level fields keep stringified
   * numerics like `"269"`. Accepted as `number` only for backwards-compat
   * with pre-flatten templates persisted on disk. */
  nodeId?: number | string;
  nodeType?: string;
  mediaType?: string;
  /**
   * Workflow-level binding for prompt-surface form fields. When present, the
   * API-prompt pipeline writes the user's value into the named widget on the
   * specified node instead of fanning the single `prompt` value across every
   * prompt-like widget on the first eligible node. Emitted by the new
   * canonical pipeline in `services/templates/formFieldPlan/`.
   * Legacy media-upload fields and the tag-only `prompt` fallback leave these
   * unset — the injector falls back to the heuristic fan-out path for them.
   */
  bindNodeId?: string;
  bindWidgetName?: string;
  /**
   * Present on regular form fields when a mode-select field exists on the
   * same form. Identifies which mode value(s) this field is relevant to.
   * undefined → always visible. A string or string[] → show only when the
   * selected mode matches one of the listed values.
   * Used by DynamicForm on the UI to hide/show fields when the user switches
   * the mode selector.
   */
  modeRequired?: string | string[];
  /**
   * All applicable mask/pad UI kinds for this image field. Each entry is
   * tagged with the subgraph wrapper it requires (`requiresMode`); entries
   * with no `requiresMode` apply in every mode. A simple inpaint template
   * yields a single entry; OneReward-style templates with both inpaint and
   * outpaint subgraphs yield one entry per pipeline so the UI can swap the
   * modal between brush and pad based on the active mode-select value.
   */
  maskable?: Array<{ kind: 'brush' | 'pad'; requiresMode?: string }>;
  /**
   * Flat id of the ImagePadForOutpaint node when maskable === 'pad'.
   * The submit path writes the user's pad values onto this node before
   * converting the workflow to an API prompt.
   */
  padTargetNodeId?: string;
}

/**
 * Resolved plugin entry attached to a TemplateData. Wire shape mirrors
 * `PluginResolution.matches[number]` + an `installed` overlay the frontend
 * uses to short-circuit the Install button. Optional on TemplateData so
 * legacy rows (pre-Phase 2) continue to parse.
 */
export interface TemplatePluginEntry {
  /** Canonical repo URL or `owner/repo` key. Matches `template_plugins.plugin_id`. */
  repo: string;
  /** Display title (Manager's `title_aux` when available). */
  title: string;
  /** Manager registry id when present. */
  cnr_id?: string;
  /** True when the plugin is installed + enabled locally (frontend overlay). */
  installed?: boolean;
}

/**
 * CivitAI origin metadata for a user-imported template. Written by the
 * Wave J CivitAI import flow so the frontend can surface a "CivitAI" badge
 * + source tags on the card without another round-trip.
 */
export interface TemplateCivitaiMeta {
  modelId: number;
  tags?: string[];
  description?: string;
  originalUrl?: string;
}

export interface TemplateData {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  mediaSubtype?: string;
  tags: string[];
  models: string[];
  /**
   * Resolved custom-node plugins the workflow requires. Union of:
   *   - aux_id/cnr_id hits from `extractDeps` (cheap, workflow-intrinsic)
   *   - Manager-resolved class_type matches from `resolveNodeTypes()`
   * See `services/templates/extractDepsAsync.ts` for the dedup rule.
   * Optional so legacy TemplateData JSON files keep loading.
   */
  plugins?: TemplatePluginEntry[];
  /**
   * Optional CivitAI origin metadata. Set on user-imported templates that
   * came in through the CivitAI URL tab. Surfaced as a badge + tags on
   * the TemplateCard.
   */
  civitaiMeta?: TemplateCivitaiMeta;
  category: string;
  studioCategory?: 'image' | 'video' | 'audio' | '3d' | 'tools';
  io: {
    inputs: Array<{
      /** Flat compound id (`"424:269"`) when the loader lives inside a
       * subgraph instance; plain stringified numeric (`"269"`) for top-level
       * loaders. Persisted-on-disk templates from before the flatten-aware
       * scanner may still carry bare numbers — kept assignable for parse. */
      nodeId: string | number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs: Array<{
      nodeId: string | number;
      nodeType: string;
      file: string;
      mediaType: string;
    }>;
  };
  formInputs?: FormInputData[];
  thumbnail: string[];
  thumbnailVariant?: string;
  workflow?: Record<string, unknown>;
  size?: number;
  vram?: number;
  usage?: number;
  openSource?: boolean;
  username?: string;
  date?: string;
  logos?: Array<{ provider: string | string[]; label?: string }>;
  searchRank?: number;
  /**
   * Provenance of the template: 1=comfy-catalog, 2=civitai, 3=github,
   * 4=upload (paste/file), 0=unknown (legacy rows pre-v23). Read from the
   * sqlite `templates.source_type` column during cache rebuild. Authoritative
   * for the "User imports" filter on the Explore page — was previously a
   * brittle `category === 'User Workflows'` string match.
   */
  source_type?: number;

  // ---- Studio Easy-mode metadata (optional; populated on per-template
  // basis for templates that drive the curated builder UIs). The legacy
  // catalog import does NOT set these; they live in the on-disk TemplateData
  // JSON and a user adds them by editing the file after import.
  //
  // The Easy-mode UI queries /api/templates for entries whose
  // `studioBuilder === <tab>`; the selected template is fetched in full via
  // /api/template-bundle/:name, which now carries `studioModes` + `promptEnhancer`.

  /**
   * Tags this template as a curated builder for one of the Easy-mode tabs.
   * Templates without this field never appear in the Easy-mode UIs and
   * stay reachable through the Advanced tab only.
   */
  studioBuilder?: 'image' | 'video' | 'audio';

  /**
   * Per-mode mute + switch configuration. The Easy-mode UI infers the
   * active mode from which inputs the user provided (see `requires`),
   * and the submit handler applies `mute` (sets `node.mode = 4` on every
   * listed id) plus optionally the switch widget value before forwarding
   * to ComfyUI.
   *
   * - `requires` — input keys that must be set for this mode to be
   *   selected (e.g. `['image', 'audio']` for a `ia2v` mode). Empty means
   *   "no extra inputs needed beyond a prompt".
   * - `mute` — node IDs to silence (`node.mode = 4`). These are the IDs
   *   of subgraph instances + unused LoadImage/LoadAudio nodes in OTHER
   *   modes. Validation skips muted nodes entirely.
   * - `switchNodeId` / `switchSlot` — when present, the submit handler
   *   writes `switchSlot` into the named node's first widget value
   *   (typically an ImpactSwitch `select` widget routing the active
   *   subgraph's output to the final SaveVideo / SaveImage node).
   */
  studioModes?: Record<string, {
    requires?: string[];
    mute?: Array<number | string>;
    switchNodeId?: number;
    switchSlot?: number;
    /**
     * Maps the Easy-mode UI's semantic input names (e.g. "image", "audio",
     * "lastFrame") onto the template's actual form-input keys
     * (e.g. "image_1", "audio_0"). VideoBuilder sends keys like `image`,
     * which by themselves don't match any form-input binding; the server
     * rewrites them via this map before workflowToApiPrompt resolves
     * widget targets. Omit / leave empty for modes that need no uploads.
     */
    inputMap?: Record<string, string>;
    /**
     * Group-aware muting via the rgthree Fast Groups Muter node. When set,
     * the submit handler walks the workflow's `groups[]` + `nodes[]` and
     * mutes every node inside any group NOT listed in `enableGroups`. The
     * result is appended to the explicit `mute: [ids]` list above — both
     * paths share the same delete-from-apiPrompt pipeline, so they compose.
     *
     * Defaults:
     *   - `fgmNodeId` omitted → auto-pick the first Fast Groups Muter node
     *     found in the workflow. If none is found, the entire FGM step is
     *     skipped (no error).
     *   - `enableGroups` omitted → `[mode]`, i.e. enable the single group
     *     whose title matches the mode key. Useful when each mode owns
     *     exactly one named group.
     */
    fgmNodeId?: number;
    enableGroups?: string[];
    /**
     * Prompt-text trigger strings that select THIS mode at submit time.
     *
     * When the UI submits, the server scans the prompt for any trigger
     * string from any mode's `triggers` array (case-insensitive, literal
     * substring match). The FIRST match wins, that mode is selected, and
     * the matched substring is STRIPPED from the prompt before it reaches
     * ComfyUI — so the model never sees the trigger.
     *
     * Convention: `@<word>` for the @-mention picker the UI exposes.
     * Templates can declare multiple triggers per mode (e.g.
     * `["@portrait", "@p"]`). Falls through to input-based `inferMode`
     * when no trigger matches.
     */
    triggers?: string[];
  }>;

  /**
   * Shared input-name translation that applies to every mode. Useful for
   * fields that bind to top-level template nodes regardless of which mode is
   * active (width/height/duration/seed in LTX-style multi-mode templates).
   * Per-mode `inputMap` overrides this on key conflicts.
   *
   * Values can be either an existing form-input id (e.g. `"primitive:406"`,
   * `"image_2"`) — resolved by the normal applyBoundFormInputs path — or a
   * direct `"<nodeId>:<widget>"` reference (e.g. `"401:value"`) for
   * top-level non-Primitive nodes (Text Multiline, etc.) the form-input
   * generator doesn't emit. The submit handler writes the second form
   * straight into apiPrompt[nodeId].inputs[widget].
   */
  studioInputMap?: Record<string, string>;

  /**
   * Per-mode UI toggle declarations. Shape:
   *   { ":" : { <key>: <label> }, <modeName>: { <key>: <label> }, ... }
   *
   * The `":"` entry applies to ALL modes (shared); per-mode entries override
   * on key collision. Each (key, label) pair causes the Easy-mode UI to
   * render one toggle button — `label` is the tooltip, `key` is what gets
   * submitted as `inputs.<key>: <bool>`.
   *
   * Server-side routing:
   *   - If `studioInputMap[key]` exists, the bool flows through that explicit
   *     pointer (path A).
   *   - Otherwise the server searches the active mode's `enableGroups` for a
   *     switch-shaped node whose title equals `<key>` (case-insensitive) and
   *     writes the bool to its first widget value.
   *   - No match either way → silently dropped.
   */
  prompt_toggles?: Record<string, Record<string, string>>;

  /**
   * Per-template prompt-enhance config consumed by the Easy-mode UI.
   * When set, the "Enhance" button calls the existing /api/llm/generate
   * endpoint with this `systemPrompt` wrapping the user's raw prompt.
   * The preferred Ollama model (e.g. `qwen2.5:7b`) is suggested but the
   * UI falls back to whatever the user has set as the global default.
   */
  promptEnhancer?: {
    systemPrompt: string;
    preferredModel?: string;
  };
}

export interface RawTemplate {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  mediaSubtype?: string;
  tags?: string[];
  models?: string[];
  date?: string;
  size?: number;
  vram?: number;
  usage?: number;
  openSource?: boolean;
  searchRank?: number;
  username?: string;
  thumbnail?: string[];
  thumbnailVariant?: string;
  logos?: Array<{ provider: string | string[]; label?: string }>;
  io?: {
    inputs?: Array<{
      nodeId: string | number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs?: Array<{
      nodeId: string | number;
      nodeType: string;
      file: string;
      mediaType: string;
    }>;
  };
}

export interface RawCategory {
  moduleName: string;
  category: string;
  icon: string;
  title: string;
  type: string;
  isEssential?: boolean;
  templates: RawTemplate[];
}
