// Widget-name scan over the emitted API prompt.
//
// Second-tier fallback after Primitive-title extraction. Walks every node
// in the apiPrompt and harvests values from well-known widget names —
// `width`, `height`, `sampler_name`, `steps`, `cfg`, ... — resolving any
// upstream wires through the shared wire helpers. Model filenames are
// collected from any `*_name` widget pointing at a known weight extension.

import { resolveLiteral } from './gallery.extract.wires.js';
import type { ApiPrompt, ScanFields } from './gallery.extract.types.js';

const MODEL_EXT_RX = /\.(safetensors|pth|ckpt|pt|bin|gguf|onnx)$/i;

interface NumberRule {
  field: keyof ScanFields;
  names: string[];
}

// Alias order defines precedence: the first name in the list that resolves to
// a number wins for that node. (Prior versions had an opt-in `preferFirst`
// flag but defaulted to last-wins because the inner loop missed a `break` on
// successful match — producing gallery metadata bugs where e.g. a node with
// both `length` and `num_frames` picked up `num_frames`'s value over `length`.)
const NUMBER_RULES: NumberRule[] = [
  { field: 'width',     names: ['width'] },
  { field: 'height',    names: ['height'] },
  { field: 'length',    names: ['length', 'num_frames', 'frames_number', 'video_length'] },
  { field: 'fps',       names: ['fps', 'frame_rate'] },
  { field: 'seed',      names: ['seed', 'noise_seed'] },
  { field: 'steps',     names: ['steps'] },
  { field: 'cfg',       names: ['cfg', 'guidance'] },
  { field: 'denoise',   names: ['denoise'] },
  { field: 'batchSize', names: ['batch_size'] },
];

const STRING_RULES: Array<{ field: keyof ScanFields; names: string[] }> = [
  { field: 'sampler',   names: ['sampler_name'] },
  { field: 'scheduler', names: ['scheduler'] },
];

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toStringVal(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function resolveNumber(prompt: ApiPrompt, value: unknown): number | null {
  const direct = toNumber(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    const lit = resolveLiteral(prompt, value);
    return toNumber(lit);
  }
  return null;
}

function resolveString(prompt: ApiPrompt, value: unknown): string | null {
  const direct = toStringVal(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    const lit = resolveLiteral(prompt, value);
    return toStringVal(lit);
  }
  return null;
}

/**
 * Scan every node's inputs for the configured widget names and record
 * the resolved literal. The caller merges this over Primitive-title
 * output so titles win when both are present on the same field.
 */
/**
 * Priority for a `*_name` input key — lower == more "main". Used to order
 * the extracted model list so `models[0]` is deterministically the primary
 * diffusion weight instead of whichever node iteration happened to touch
 * first. Previously the model list just inherited `Object.values(prompt)`
 * iteration order, so re-scans of the same workflow could report a different
 * `model` field (VAE or CLIP instead of the checkpoint) and the
 * `COALESCE(gallery.model, excluded.model)` upsert would pin the wrong one.
 */
function modelPriority(inputKey: string): number {
  if (inputKey === 'ckpt_name' || inputKey === 'unet_name' || inputKey === 'model_name') return 0;
  if (inputKey === 'controlnet_name' || inputKey === 'upscale_model_name' || inputKey === 'style_model_name') return 1;
  if (inputKey === 'lora_name') return 2;
  if (inputKey === 'vae_name') return 3;
  if (inputKey === 'clip_name' || inputKey === 'text_encoder') return 4;
  return 5;
}

export function scanWidgets(prompt: ApiPrompt): Partial<ScanFields> {
  const out: Partial<ScanFields> = {};
  // Track the lowest (== most primary) priority seen per filename. Same
  // weight file can be referenced by multiple keys (e.g. a model loaded
  // twice); the first-found key's priority wins after canonical sorting.
  const modelPriorities = new Map<string, number>();

  for (const node of Object.values(prompt)) {
    const inputs = node?.inputs;
    if (!inputs) continue;

    for (const rule of NUMBER_RULES) {
      if (out[rule.field] != null) continue;
      for (const name of rule.names) {
        if (!(name in inputs)) continue;
        const n = resolveNumber(prompt, inputs[name]);
        if (n !== null) {
          (out[rule.field] as number) = n;
          // First-wins: stop scanning aliases on this node once we have a value.
          // Without this break, a node declaring multiple aliases let the LAST
          // match overwrite the FIRST (see NumberRule comment above).
          break;
        }
      }
    }

    for (const rule of STRING_RULES) {
      if (out[rule.field] != null) continue;
      for (const name of rule.names) {
        if (!(name in inputs)) continue;
        const s = resolveString(prompt, inputs[name]);
        if (s !== null && s !== '') {
          (out[rule.field] as string) = s;
          break;
        }
      }
    }

    // Collect model filenames from any `*_name` input that resolves to a
    // string with a known weights extension. Covers ckpt_name, unet_name,
    // lora_name, vae_name, text_encoder, model_name, ...
    for (const [key, raw] of Object.entries(inputs)) {
      if (!key.endsWith('_name') && key !== 'text_encoder') continue;
      const s = resolveString(prompt, raw);
      if (!s || !MODEL_EXT_RX.test(s)) continue;
      const pri = modelPriority(key);
      const prev = modelPriorities.get(s);
      if (prev === undefined || pri < prev) modelPriorities.set(s, pri);
    }
  }

  if (modelPriorities.size > 0) {
    out.models = [...modelPriorities.entries()]
      .sort(([aName, aPri], [bName, bPri]) => aPri - bPri || aName.localeCompare(bName))
      .map(([name]) => name);
  }
  return out;
}
