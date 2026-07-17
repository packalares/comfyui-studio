// Unified download shape for the Downloads tab.
// Additive on top of the existing DownloadState from system.contract.ts —
// the WS bus still emits { type: 'download', data: DownloadState } for ComfyUI
// model downloads. The unified view extends DownloadState with source/kind/timing
// fields so the UI can group by source and display Ollama pulls alongside model downloads.

export interface UnifiedDownload {
  id: string;
  source: 'comfy' | 'ollama';
  /** Broad category: 'lora' | 'checkpoint' | 'llm' | 'other' (open string for forward compat). */
  kind: string;
  /** Human-readable display name. */
  name: string;
  status: 'queued' | 'downloading' | 'success' | 'failed' | 'canceled';
  progress?: { bytes: number; total?: number; percent?: number };
  error?: string;
  /** Epoch ms when the download was enqueued. */
  queuedAt?: number;
  /** Epoch ms when the download actually started transferring bytes. */
  startedAt?: number;
  /** Epoch ms when the download reached a terminal state (success/failed/canceled). */
  finishedAt?: number;
}
