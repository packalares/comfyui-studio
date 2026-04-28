// Canonical shapes for the model catalog. Services and routes import from
// here; no other file should re-declare these interfaces.

export type FileStatus = 'complete' | 'incomplete' | 'corrupt' | null;

/** Host family for a catalog URL source. Lower priority value = preferred. */
export type UrlHost = 'hf' | 'civitai' | 'github' | 'generic';

/**
 * One declared download URL for a catalog row. Multiple sources accumulate as
 * different code paths discover URLs for the same filename — seed (model-list),
 * template imports, manual user resolution, etc. The list is dedup-merged and
 * sorted by host priority so the legacy `url` field always reflects the
 * highest-priority URL the catalog has seen.
 */
export interface UrlSource {
  url: string;
  host: UrlHost;
  /** Discovery context: 'seed' | 'template:<name>' | 'user' | 'manual' | 'scan'. */
  declaredBy: string;
}

/** A single catalog entry, keyed globally by `filename`. */
export interface CatalogModel {
  filename: string;
  name: string;
  type: string;
  base?: string;
  save_path: string;
  description?: string;
  reference?: string;
  /**
   * Legacy single-URL field — kept populated for backwards compatibility with
   * every existing reader. Mirrors `urlSources[0].url` after sort.
   */
  url: string;
  /**
   * Append-only list of all discovered URLs for this filename, sorted by host
   * priority (hf=0, civitai=1, github=2, generic=3). Migrations synthesize a
   * single entry from legacy `url` when this field is absent.
   */
  urlSources?: UrlSource[];
  size_pretty: string;
  size_bytes: number;
  size_fetched_at: string | null;
  gated?: boolean;
  gated_message?: string;
  /** Where this entry was first discovered: 'comfyui' seed, 'template:<name>', 'user', or 'scan'. */
  source: string;
  /** Optional preview image URL (populated at download-start from card metadata). */
  thumbnail?: string;
  /** In-flight download marker. Set true at download-start; cleared on completion. */
  downloading?: boolean;
  /** Last download failure message. Cleared when a subsequent download starts. */
  error?: string;
}

/** Catalog entry augmented with on-disk state from the launcher scan. */
export interface MergedModel extends CatalogModel {
  installed: boolean;
  fileSize?: number;
  fileStatus?: FileStatus;
}
