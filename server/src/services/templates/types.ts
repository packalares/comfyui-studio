// Shared template data shapes for the templates service split.

export interface FormInputData {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'image' | 'audio' | 'video' | 'number' | 'slider' | 'select' | 'toggle';
  required: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
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
