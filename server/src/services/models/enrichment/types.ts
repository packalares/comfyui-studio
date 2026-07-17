// Pure types for the model-enrichment layer.
// These mirror §4.1–4.4 of the LoRA integration plan.

/** All known model type identifiers used across the enrichment pipeline. */
export type ModelType =
  | 'lora' | 'checkpoint' | 'vae' | 'embedding' | 'controlnet'
  | 'ip_adapter' | 'clip' | 'clip_vision' | 'unet' | 'diffusion_model'
  | 'upscaler' | 'llm' | 'other';

// ---- URL source verification ----

/** Verification verdict for a single URL source entry. */
export interface UrlSourceVerdict {
  url: string;
  host: string;
  declaredBy?: string;
  /** SHA256 retrieved from upstream (when available). */
  sha256?: string;
  status: 'ok' | 'mismatch' | 'unknown' | 'error';
  error?: string;
}

// ---- Sidecar shape ----

/**
 * Fields common to every model type. Stored in `{basename}.metadata.json`
 * alongside the model file (CLM-compatible sidecar format).
 */
export interface BaseModelMeta {
  // Identity
  filename: string;
  save_path: string;

  // Hash (D1 — full-file SHA256)
  sha256?: string;
  sha256_status?: 'pending' | 'computing' | 'done' | 'error';

  // Display
  model_name?: string;
  base_model?: string;
  description?: string;
  tags?: string[];
  trigger_words?: string[];

  // Enrichment provenance
  metadata_source?: 'civitai' | 'manual' | 'none';
  civitai_model_id?: number;
  civitai_version_id?: number;
  /** True when the model was deleted from CivitAI after enrichment. */
  civitai_deleted?: boolean;
  hf_repo?: string;

  // Media
  preview_local_path?: string;
  preview_remote_url?: string;

  // Content rating (integer, mirrors CivitAI nsfwLevel scale)
  // 0=None 1=Soft 2=Mature 3=X 4=XXX
  nsfw_level?: number;

  // User fields — MUST be preserved on re-enrich
  favorite?: boolean;
  exclude?: boolean;
  notes?: string;
  usage_tips?: string;

  // Control flags
  skip_metadata_refresh?: boolean;
  last_enriched_at?: string; // ISO-8601

  // Raw upstream payload for debugging/re-parsing
  civitai_raw?: unknown;

  // URL source verification results (written after successful enrichment)
  urlSources_verified?: UrlSourceVerdict[];
}

// ---- Subtype extras ----

export interface LoraExtra {
  usage_tips?: string;
  strength_default?: number;
}

export interface CheckpointExtra {
  sub_type?: 'checkpoint' | 'diffusion_model' | 'unet';
}

export interface EmbeddingExtra {
  sub_type?: 'embedding' | 'textual_inversion';
}

// ---- Source interface ----

/** Display-relevant subset extracted from an upstream enrichment response. */
export interface ModelSourceResult {
  model_name?: string;
  base_model?: string;
  description?: string;
  tags?: string[];
  trigger_words?: string[];
  nsfw_level?: number;
  metadata_source: 'civitai';
  civitai_model_id?: number;
  civitai_version_id?: number;
  preview_remote_url?: string;
  civitai_raw?: unknown;
  /** HuggingFace owner/repo identifier — kept for downloads/UI, may be set from urlSources. */
  hf_repo?: string;
}

/**
 * Abstraction for an upstream enrichment provider (CivitAI, HuggingFace …).
 * Each implementation returns `null` when the model isn't found.
 */
export interface ModelSource {
  searchByHash(sha256: string): Promise<ModelSourceResult | null>;
  searchByName(filename: string, modelType: ModelType): Promise<ModelSourceResult | null>;
}

/** Wire shape added to catalog rows when a sidecar is present. */
export interface CatalogEnrichment {
  tags?: string[];
  trigger_words?: string[];
  nsfw_level?: number;
  favorite?: boolean;
  metadata_source?: string;
  civitai_model_id?: number;
  civitai_version_id?: number;
  preview_remote_url?: string;
  base_model?: string;
  hf_repo?: string;
}
