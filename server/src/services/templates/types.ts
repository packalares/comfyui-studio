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
  nodeId?: number;
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
      nodeId: number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs: Array<{
      nodeId: number;
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
      nodeId: number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs?: Array<{
      nodeId: number;
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
