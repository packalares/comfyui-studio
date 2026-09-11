// GGUF header reader — parses the metadata KV block + tensor descriptors from a
// GGUF file (llama.cpp / quantized ComfyUI UNets) without reading tensor data.
//
// Layout: magic "GGUF" | version u32 | tensor_count u64 | kv_count u64 |
//         kv pairs | tensor infos. Each value is typed; arrays carry an inner
//         type + length. We walk the whole KV block (to reach the tensors) and
//         capture scalar metadata (general.architecture, general.file_type, …)
//         plus each tensor's name / dims / ggml type. Offsets are skipped.

import fs from 'node:fs';
import type { Integrity } from './safetensors.js';

export interface GgufHeader {
  ok: boolean;
  integrity: Integrity;
  integrityNote?: string;
  version: number;
  metadata: Record<string, string>;
  /** tensor name -> ggml type token (Q4_K, Q6_K, F16, BF16, …). */
  dtypes: Record<string, string>;
  tensorNames: string[];
  paramTotal: number;
}

// ggml_type -> label. Covers the common quant + float types.
const GGML_TYPE: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0',
  9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K',
  15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S',
  20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16',
  26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M', 30: 'BF16',
};

const MAX_READ = 64 * 1024 * 1024; // read at most 64 MiB — headers fit easily
const MAX_KV = 8192;
const MAX_TENSORS = 500_000;
const MAX_STRING = 1 << 20;

class Cursor {
  pos = 0;
  constructor(private buf: Buffer) {}
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('unexpected end of GGUF header');
  }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64(): number { this.need(8); const v = Number(this.buf.readBigUInt64LE(this.pos)); this.pos += 8; return v; }
  i64(): number { this.need(8); const v = Number(this.buf.readBigInt64LE(this.pos)); this.pos += 8; return v; }
  f32(): number { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  i8(): number { this.need(1); const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  u8(): number { this.need(1); const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  str(): string {
    const len = this.u64();
    if (len > MAX_STRING) throw new Error('GGUF string too long');
    this.need(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  // Read one typed value; returns a scalar string form (for metadata) or ''.
  value(type: number, depth = 0): string {
    switch (type) {
      case 0: return String(this.u8());
      case 1: return String(this.i8());
      case 2: { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return String(v); }
      case 3: { this.need(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return String(v); }
      case 4: return String(this.u32());
      case 5: { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return String(v); }
      case 6: return String(this.f32());
      case 7: return String(this.u8() !== 0);
      case 8: return this.str();
      case 10: return String(this.u64());
      case 11: return String(this.i64());
      case 12: return String(this.f64());
      case 9: {
        if (depth > 1) throw new Error('GGUF array nested too deep');
        const itemType = this.u32();
        const n = this.u64();
        if (n > 1_000_000) throw new Error('GGUF array too large');
        const parts: string[] = [];
        for (let i = 0; i < n; i++) {
          const s = this.value(itemType, depth + 1);
          if (i < 16) parts.push(s); // keep only a preview for metadata
        }
        return parts.join(',');
      }
      default:
        throw new Error(`unknown GGUF value type ${type}`);
    }
  }
}

export function readGgufHeader(absPath: string): GgufHeader {
  const res: GgufHeader = {
    ok: false, integrity: 'unreadable', version: 0,
    metadata: {}, dtypes: {}, tensorNames: [], paramTotal: 0,
  };
  let fd: number | undefined;
  try {
    const size = fs.statSync(absPath).size;
    fd = fs.openSync(absPath, 'r');
    const toRead = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, 0);

    if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'GGUF') {
      res.integrity = 'not_a_model';
      res.integrityNote = 'missing GGUF magic';
      return res;
    }

    const c = new Cursor(buf);
    c.pos = 4;
    res.version = c.u32();
    const nTensors = c.u64();
    const nKv = c.u64();
    if (nTensors > MAX_TENSORS || nKv > MAX_KV) {
      res.integrity = 'invalid_header';
      res.integrityNote = `implausible counts (tensors=${nTensors}, kv=${nKv})`;
      return res;
    }

    for (let i = 0; i < nKv; i++) {
      const key = c.str();
      const type = c.u32();
      const v = c.value(type);
      if (v.length <= 4000) res.metadata[key] = v;
    }

    for (let i = 0; i < nTensors; i++) {
      const name = c.str();
      const ndim = c.u32();
      if (ndim > 8) throw new Error('GGUF tensor rank too high');
      let n = 1;
      for (let d = 0; d < ndim; d++) n *= c.u64();
      const ggmlType = c.u32();
      c.u64(); // data offset — discarded
      res.tensorNames.push(name);
      res.dtypes[name] = GGML_TYPE[ggmlType] ?? `GGML_${ggmlType}`;
      res.paramTotal += n;
    }

    res.ok = true;
    res.integrity = 'ok';
    return res;
  } catch (err) {
    // A parse that runs off the end of our 64 MiB read window is "unsupported"
    // rather than corrupt — the file may be a valid but unusually huge header.
    res.integrity = 'invalid_header';
    res.integrityNote = err instanceof Error ? err.message : String(err);
    return res;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
