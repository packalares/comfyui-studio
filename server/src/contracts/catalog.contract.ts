// Canonical shapes for the model catalog. Services and routes import from
// here; no other file should re-declare these interfaces.

export type FileStatus = 'complete' | 'incomplete' | 'corrupt' | null;

/** A single catalog entry, keyed globally by `filename`. */
export interface CatalogModel {
  filename: string;
  name: string;
  type: string;
  base?: string;
  save_path: string;
  description?: string;
  reference?: string;
  url: string;
  size_pretty: string;
  size_bytes: number;
  size_fetched_at: string | null;
  gated?: boolean;
  gated_message?: string;
  /** Where this entry was first discovered: 'comfyui' seed, 'template:<name>', 'user', or 'scan'. */
  source: string;
}

/** Catalog entry augmented with on-disk state from the launcher scan. */
export interface MergedModel extends CatalogModel {
  installed: boolean;
  fileSize?: number;
  fileStatus?: FileStatus;
}
