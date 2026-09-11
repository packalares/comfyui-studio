// Architecture / role / precision detection from a parsed model header.
//
// Layered, measured-vs-inferred: metadata (authoritative) > structural key
// signature > SD shape probe > filename prior (caller's job). Every conclusion
// appends to `signals` so the UI can show HOW it was decided, and `archSource`
// tags whether the family is measured or a guess.

import type { ModelHeader } from '../header/index.js';
import {
  RULES, METADATA_KEYS, METADATA_MAP, ADAPTER_SUFFIXES,
  PRECISION_BY_DTYPE, DTYPE_BITS, FAMILIES, type Rule,
} from './rules.js';

export type ArchSource = 'metadata' | 'structural' | 'shape' | 'prior' | 'none';

export interface ArchResult {
  archFamily: string;
  archSource: ArchSource;
  archConfidence: number;
  role: string;
  precision: string;
  quantization: string | null;
  paramCount: number;
  isBundled: boolean;
  signals: string[];
}

// ---- KeyView: fast substring / prefix matching over the tensor key set ----
class KeyView {
  private top = new Set<string>();
  private lvl2 = new Set<string>();
  private joined: string;
  constructor(keys: string[]) {
    for (const k of keys) {
      const parts = k.split('.');
      if (parts[0]) this.top.add(parts[0]);
      if (parts[0] && parts[1]) this.lvl2.add(`${parts[0]}.${parts[1]}`);
    }
    this.joined = '\n' + keys.join('\n') + '\n';
  }
  has(token: string): boolean {
    if (token.startsWith('~')) return this.joined.includes(token.slice(1));
    return this.top.has(token) || this.lvl2.has(token);
  }
}

function matchRules(view: KeyView): Rule | null {
  for (const r of RULES) {
    if (r.requires.length === 0) continue;
    if (!r.requires.every((t) => view.has(t))) continue;
    if (r.forbids.some((t) => view.has(t))) continue;
    return r;
  }
  return null;
}

function familyFromMetadata(meta: Record<string, string>): { family: string; via: string } | null {
  for (const key of METADATA_KEYS) {
    const raw = meta[key];
    if (!raw) continue;
    const low = raw.toLowerCase();
    for (const [token, family] of METADATA_MAP) {
      if (low.includes(token)) return { family, via: `${key}='${raw.slice(0, 40)}'` };
    }
  }
  return null;
}

// SD family variant from the cross-attention context dim (768 / 1024 / 2048).
function sdVariantFromShapes(h: ModelHeader): { family: string; note: string } | null {
  for (const [name, shape] of Object.entries(h.shapes)) {
    if (!/attn2\.to_k\.weight$|attn2\.to_v\.weight$/.test(name)) continue;
    const ctx = shape[1]; // Linear weight is [out, in]; in = context dim
    if (ctx === 768) return { family: 'SD1.5', note: 'cross-attn context dim 768' };
    if (ctx === 1024) return { family: 'SD2.x', note: 'cross-attn context dim 1024' };
    if (ctx === 2048) return { family: 'SDXL', note: 'cross-attn context dim 2048' };
  }
  // SDXL also carries a label/add embedding the earlier families lack.
  for (const name of Object.keys(h.shapes)) {
    if (/add_embedding|label_emb/.test(name)) return { family: 'SDXL', note: 'has add/label embedding' };
  }
  return null;
}

// LoRA / adapter: count adapter-suffix keys; rank measured from tensor shape.
function detectAdapter(h: ModelHeader): { isAdapter: boolean; format: string; rank: number | null } {
  const total = h.keys.length || 1;
  const counts: Record<string, number> = {};
  let hits = 0;
  let rank: number | null = null;
  for (const k of h.keys) {
    for (const [suffix, fmt] of ADAPTER_SUFFIXES) {
      if (k.endsWith(suffix)) {
        counts[fmt] = (counts[fmt] ?? 0) + 1;
        hits++;
        if (rank === null) {
          const shape = h.shapes[k];
          if (shape) {
            if (suffix.includes('down') || suffix.includes('_A')) rank = shape[0] ?? null;
            else if (suffix.includes('up') || suffix.includes('_B')) rank = shape[1] ?? null;
          }
        }
        break;
      }
    }
  }
  if (hits / total < 0.05) return { isAdapter: false, format: '', rank: null };
  const format = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'lora';
  return { isAdapter: true, format, rank };
}

function isBundledCheckpoint(view: KeyView): boolean {
  const hasUnet = view.has('~model.diffusion_model') || view.has('~double_blocks')
    || view.has('~input_blocks') || view.has('~joint_blocks');
  const hasVae = view.has('~first_stage_model') || view.has('~encoder.down');
  const hasTE = view.has('~cond_stage_model') || view.has('~conditioner')
    || view.has('~text_model') || view.has('~text_encoders');
  return hasUnet && (hasVae || hasTE);
}

// Dominant precision + quantization from a numel-weighted dtype histogram.
function precisionAndQuant(h: ModelHeader): { precision: string; quantization: string | null } {
  const weight: Record<string, number> = {};
  for (const [name, dtype] of Object.entries(h.dtypes)) {
    const shape = h.shapes[name];
    let numel = 1;
    if (shape && shape.length) { numel = shape.reduce((a, b) => a * (b > 0 ? b : 1), 1); }
    weight[dtype] = (weight[dtype] ?? 0) + numel;
  }
  const entries = Object.entries(weight);
  if (entries.length === 0) return { precision: 'unknown', quantization: null };
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0][0];

  let quantization: string | null = null;
  if (top === 'F8_E4M3' || top === 'F8_E5M2') quantization = PRECISION_BY_DTYPE[top];
  else if (top === 'I8' || top === 'U8') quantization = 'int8';
  else if (top === 'NF4' || top === 'F4') quantization = PRECISION_BY_DTYPE[top];
  else if (/^Q\d|^IQ\d|^Q\d_K/.test(top)) quantization = `gguf_${top.toLowerCase()}`;

  let precision = PRECISION_BY_DTYPE[top] ?? top.toLowerCase();
  // "mixed" only when >2 distinct real (>=4-bit) precisions are present.
  const distinct = new Set(
    entries.map(([d]) => d).filter((d) => (DTYPE_BITS[d] ?? 0) >= 4).map((d) => PRECISION_BY_DTYPE[d] ?? d.toLowerCase()),
  );
  if (distinct.size > 2 && !quantization) precision = 'mixed';

  return { precision, quantization };
}

export function detectArch(h: ModelHeader): ArchResult {
  const res: ArchResult = {
    archFamily: 'Unknown', archSource: 'none', archConfidence: 0,
    role: 'unknown', precision: 'unknown', quantization: null,
    paramCount: h.paramTotal, isBundled: false, signals: [],
  };

  if (!h.ok || h.keys.length === 0) {
    res.signals.push(`header not usable (${h.integrity})`);
    return res;
  }

  const view = new KeyView(h.keys);
  const pq = precisionAndQuant(h);
  res.precision = pq.precision;
  res.quantization = pq.quantization;
  res.isBundled = isBundledCheckpoint(view);

  // 1) structural signature
  const rule = matchRules(view);
  if (rule) {
    res.archFamily = rule.family;
    res.role = rule.role;
    res.archSource = 'structural';
    res.archConfidence = rule.confidence;
    res.signals.push(`rule:${rule.name}`);
  }

  // 2) metadata is authoritative — overrides structural family
  const meta = familyFromMetadata(h.metadata);
  if (meta) {
    if (res.archFamily !== meta.family) res.signals.push(`metadata family ${meta.family} (${meta.via})`);
    res.archFamily = meta.family;
    res.archSource = 'metadata';
    res.archConfidence = 0.95;
  }

  // 3) SD variant shape probe (only when family is the generic SD placeholder
  //    and not already pinned by metadata)
  if (res.archSource !== 'metadata' && (res.archFamily === 'StableDiffusion')) {
    const sv = sdVariantFromShapes(h);
    if (sv) {
      res.archFamily = sv.family;
      res.archSource = 'shape';
      res.archConfidence = 0.88;
      res.signals.push(sv.note);
    }
  }

  // 4) adapter / LoRA — role override + rank; family often from metadata above
  const ad = detectAdapter(h);
  if (ad.isAdapter) {
    res.role = 'lora';
    res.signals.push(`adapter:${ad.format}${ad.rank ? ` rank=${ad.rank}` : ''}`);
    if (res.archSource === 'none') { res.archSource = 'prior'; res.archConfidence = 0.4; }
  }

  // 5) parsed but unmatched -> Other (not Unknown; Unknown means unreadable)
  if (res.archFamily === 'Unknown') {
    res.archFamily = 'Other';
    res.archSource = 'prior';
    res.archConfidence = 0.3;
    res.signals.push('parsed but outside the known family vocabulary');
  }

  // sanity: never emit a family outside the vocabulary except the Other sentinel
  if (res.archFamily !== 'Other' && !FAMILIES.has(res.archFamily)) {
    res.signals.push(`note: '${res.archFamily}' not in canonical family set`);
  }

  res.signals = res.signals.slice(0, 8);
  return res;
}
