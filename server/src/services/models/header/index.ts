// Unified model-header entry point: dispatch by extension to the safetensors or
// GGUF reader and normalise both into a single `ModelHeader` shape that the arch
// detector consumes.

import path from 'node:path';
import { readSafetensorsHeader, type Integrity } from './safetensors.js';
import { readGgufHeader } from './gguf.js';

export type { Integrity } from './safetensors.js';

export interface ModelHeader {
  format: 'safetensors' | 'gguf' | 'unknown';
  ok: boolean;
  integrity: Integrity;
  integrityNote?: string;
  /** Tensor names. */
  keys: string[];
  /** name -> shape dims. Safetensors only (GGUF header carries dims but we
   *  don't retain per-tensor shapes there — shape probes are SD-safetensors). */
  shapes: Record<string, number[]>;
  /** name -> dtype/ggml-type token. */
  dtypes: Record<string, string>;
  /** __metadata__ (safetensors) or KV block (GGUF), string values. */
  metadata: Record<string, string>;
  paramTotal: number;
}

const SAFETENSORS_EXT = new Set(['.safetensors', '.sft']);
const GGUF_EXT = new Set(['.gguf']);

/** True for extensions this module can parse a header from. */
export function isHeaderParsable(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  return SAFETENSORS_EXT.has(ext) || GGUF_EXT.has(ext);
}

export function parseModelHeader(absPath: string): ModelHeader {
  const ext = path.extname(absPath).toLowerCase();

  if (SAFETENSORS_EXT.has(ext)) {
    const h = readSafetensorsHeader(absPath);
    return {
      format: 'safetensors',
      ok: h.ok,
      integrity: h.integrity,
      integrityNote: h.integrityNote,
      keys: h.keys,
      shapes: h.shapes,
      dtypes: h.dtypes,
      metadata: h.metadata,
      paramTotal: h.paramTotal,
    };
  }

  if (GGUF_EXT.has(ext)) {
    const h = readGgufHeader(absPath);
    return {
      format: 'gguf',
      ok: h.ok,
      integrity: h.integrity,
      integrityNote: h.integrityNote,
      keys: h.tensorNames,
      shapes: {},
      dtypes: h.dtypes,
      metadata: h.metadata,
      paramTotal: h.paramTotal,
    };
  }

  return {
    format: 'unknown',
    ok: false,
    integrity: 'unsupported_format',
    integrityNote: `no header reader for ${ext || '(no extension)'}`,
    keys: [], shapes: {}, dtypes: {}, metadata: {}, paramTotal: 0,
  };
}
