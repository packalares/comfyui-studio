// Safetensors header reader — reads the JSON header WITHOUT loading any tensor
// data into RAM, so a multi-GB checkpoint is inspected in milliseconds.
//
// Layout: [8-byte little-endian uint64 header length][header JSON][tensor data].
// The header JSON maps tensor name -> {dtype, shape, data_offsets}, plus an
// optional "__metadata__" object. We read only the length prefix + the header
// bytes; the tensor payload is never touched.
//
// Every file-level problem becomes a tagged result (integrity != 'ok'), never
// a thrown error — a corrupt/mislabelled file is flagged, not crash-parsed.

import fs from 'node:fs';

export type Integrity =
  | 'ok'
  | 'truncated'
  | 'invalid_header'
  | 'not_a_model'
  | 'unsupported_format'
  | 'unreadable';

export interface SafetensorsHeader {
  ok: boolean;
  integrity: Integrity;
  integrityNote?: string;
  /** Tensor names (excludes the "__metadata__" pseudo-entry). */
  keys: string[];
  /** name -> shape dims (ints only). */
  shapes: Record<string, number[]>;
  /** name -> safetensors dtype token (F16, BF16, F8_E4M3, I8, F32, …). */
  dtypes: Record<string, string>;
  /** "__metadata__" string values, capped. */
  metadata: Record<string, string>;
  /** Sum of element counts across all tensors (measured from shapes). */
  paramTotal: number;
  headerBytes: number;
}

const MAX_HEADER = 200 * 1024 * 1024; // 200 MiB — a header larger than this is bogus
const METADATA_VALUE_CAP = 4000;
// Byte prefixes that mean "this .safetensors is actually an error page / LFS
// pointer / HTML", never a model. No `{` needle — a legit little-endian length
// like 0x0A7B starts the file with "{\n", so JSON error pages are caught by the
// length-plausibility check instead.
const HTML_SNIFF = ['<!doctype', '<html', '<?xml', 'version http'];

function numel(shape: number[]): number {
  let n = 1;
  for (const d of shape) {
    if (!Number.isInteger(d) || d < 0) return 0;
    n *= d;
  }
  return n;
}

export function readSafetensorsHeader(absPath: string): SafetensorsHeader {
  const res: SafetensorsHeader = {
    ok: false,
    integrity: 'unreadable',
    keys: [],
    shapes: {},
    dtypes: {},
    metadata: {},
    paramTotal: 0,
    headerBytes: 0,
  };

  let fd: number | undefined;
  try {
    const size = fs.statSync(absPath).size;
    fd = fs.openSync(absPath, 'r');

    // Read a small lead: first 8 bytes are the length prefix, the rest lets us
    // sniff text markers ("version http…" LFS pointers need 12 chars).
    const leadLen = Math.min(32, Math.max(8, size));
    const lead = Buffer.alloc(leadLen);
    const readLead = fs.readSync(fd, lead, 0, leadLen, 0);
    if (readLead < 8) {
      res.integrity = 'truncated';
      res.integrityNote = 'file shorter than the 8-byte header length prefix';
      return res;
    }

    const sniff = lead.toString('latin1', 0, readLead).toLowerCase();
    if (HTML_SNIFF.some((s) => sniff.startsWith(s))) {
      res.integrity = 'not_a_model';
      res.integrityNote = 'HTML/XML/LFS-pointer content saved as .safetensors';
      return res;
    }

    const headerLen = Number(lead.readBigUInt64LE(0));
    res.headerBytes = headerLen;
    if (headerLen < 2 || headerLen > Math.min(MAX_HEADER, Math.max(0, size - 8))) {
      res.integrity = 'invalid_header';
      res.integrityNote = headerLen > MAX_HEADER
        ? `declared header ${headerLen} bytes exceeds the ${MAX_HEADER}-byte cap`
        : `declared header length ${headerLen} is impossible for a ${size}-byte file`;
      return res;
    }

    const raw = Buffer.alloc(headerLen);
    const readHdr = fs.readSync(fd, raw, 0, headerLen, 8);
    if (readHdr < headerLen) {
      res.integrity = 'truncated';
      res.integrityNote = 'header shorter than its declared length';
      return res;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      res.integrity = 'invalid_header';
      res.integrityNote = 'header is not valid JSON';
      return res;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.integrity = 'invalid_header';
      res.integrityNote = 'header JSON is not an object';
      return res;
    }

    const obj = parsed as Record<string, unknown>;
    for (const [name, val] of Object.entries(obj)) {
      if (name === '__metadata__') {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const [mk, mv] of Object.entries(val as Record<string, unknown>)) {
            const s = typeof mv === 'string' ? mv : JSON.stringify(mv);
            res.metadata[mk] = s.length > METADATA_VALUE_CAP
              ? s.slice(0, METADATA_VALUE_CAP)
              : s;
          }
        }
        continue;
      }
      if (!val || typeof val !== 'object') continue;
      const t = val as Record<string, unknown>;
      const dtype = typeof t.dtype === 'string' ? t.dtype : undefined;
      const shape = Array.isArray(t.shape)
        ? (t.shape.filter((d) => typeof d === 'number') as number[])
        : [];
      res.keys.push(name);
      res.shapes[name] = shape;
      if (dtype) res.dtypes[name] = dtype;
      res.paramTotal += numel(shape);
    }

    if (res.keys.length === 0) {
      res.integrity = 'invalid_header';
      res.integrityNote = 'header declares no tensors';
      return res;
    }

    res.ok = true;
    res.integrity = 'ok';
    return res;
  } catch (err) {
    res.integrity = 'unreadable';
    res.integrityNote = err instanceof Error ? err.message : String(err);
    return res;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
