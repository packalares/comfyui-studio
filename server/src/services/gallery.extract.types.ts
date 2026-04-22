// Shared type definitions for the gallery extractor pipeline.
//
// Living in their own module so the orchestrator (gallery.extract.ts) and
// the satellite helpers (wires/titles/scan) can each import them without
// introducing a cycle back through the orchestrator.

export interface ApiPromptNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

export type ApiPrompt = Record<string, ApiPromptNode>;

export interface ExtractedMetadata {
  promptText: string | null;
  negativeText: string | null;
  seed: number | null;
  model: string | null;
  sampler: string | null;
  scheduler: string | null;
  steps: number | null;
  cfg: number | null;
  denoise: number | null;
  width: number | null;
  height: number | null;
  length: number | null;
  fps: number | null;
  batchSize: number | null;
  durationMs: number | null;
  models: string[];
}

// Subsets produced by title + scan passes. Each pass leaves the fields it
// doesn't know about as `undefined`; the orchestrator merges with precedence.
export type TitleFields = Omit<ExtractedMetadata, 'durationMs' | 'model' | 'models'>;
export type ScanFields  = Omit<ExtractedMetadata, 'durationMs' | 'model' | 'promptText' | 'negativeText'>;
