// Builds the YAML config `run.py` expects, and a minimal YAML serializer to
// emit it (no new npm dependency — see the serializer's doc comment).
//
// Field names/shape were verified against ostris/ai-toolkit's actual source
// at authoring time (2026-07-18, `main` branch):
//   - `config/examples/train_lora_flux_24gb.yaml` — the canonical example
//     for the `job: extension` / `config.process[0].type: sd_trainer` shape.
//   - `toolkit/config_modules.py` — `ModelConfig` (is_flux/is_xl/is_v3 arch
//     flags), `NetworkConfig` (linear/linear_alpha == rank/alpha),
//     `SaveConfig`, `TrainConfig` (disable_sampling lets the `sample:` block
//     be omitted entirely — SampleConfig defaults `prompts` to `[]`), and
//     `DatasetConfig` (folder_path/caption_ext/resolution).
//   - `jobs/process/BaseTrainProcess.py` / `BaseSDTrainProcess.py` — confirms
//     `save_root = training_folder/<config.name>` and that the final
//     (un-stepped) checkpoint is `<save_root>/<config.name>.safetensors`,
//     written once via `self.save()` at the very end of the training loop.
// TODO: ai-toolkit's config schema is not a stable/versioned API — a future
// upstream change could rename/restructure any of this. No automated check
// pins it; if training starts failing with a config-parsing traceback,
// re-diff against the files above.

import path from 'path';
import fs from 'fs';

export type AiToolkitArch = 'flux' | 'sdxl' | 'sd35' | 'other';

export interface AiToolkitTrainConfigInput {
  /** Sanitized job identifier — becomes `config.name`, the save-folder name,
   *  and the tqdm progress-bar `desc` (see train.ts's progress-line regex). */
  jobName: string;
  /** Local absolute checkpoint path OR a bare `org/repo` HuggingFace id. */
  baseModelPath: string;
  arch: AiToolkitArch;
  /** Absolute path to a folder of images + sibling `<basename>.txt` captions. */
  datasetDir: string;
  /** Absolute root `run.py` writes `<jobName>/` under. */
  trainingFolder: string;
  triggerWord?: string;
  steps: number;
  learningRate: number;
  rank: number;
  alpha?: number;
  batchSize: number;
  resolution: number;
  saveEvery: number;
  seed?: number;
  lowVram?: boolean;
}

/**
 * Minimal recursive-descent YAML emitter for plain JSON-shaped values
 * (objects/arrays/strings/numbers/booleans/null — no anchors, no multiline
 * block scalars). Written instead of pulling in the `yaml` npm package
 * because `yaml` is only present in this repo as an indirect dependency of
 * eslint (not a direct `server/package.json` dependency) — depending on it
 * from runtime code would be fragile (a future `npm install` could dedupe it
 * away). PyYAML (what ai-toolkit's `run.py` actually parses with) accepts
 * this block-style output; double-quoting is used for any scalar that could
 * otherwise be misread as a YAML type (numbers/bools/null) or that contains
 * YAML-significant punctuation.
 */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  const looksLikeOtherType = /^(true|false|null|~|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(s);
  const needsQuoting = s === ''
    || /^\s|\s$/.test(s)
    || /[:#[\]{}&*!|>'"%@`,]/.test(s)
    || looksLikeOtherType;
  return needsQuoting ? JSON.stringify(s) : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toYamlLines(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value.map((item) => {
      if (isPlainObject(item) || Array.isArray(item)) {
        return `${pad}-\n${toYamlLines(item, indent + 1)}`;
      }
      return `${pad}- ${yamlScalar(item)}\n`;
    }).join('');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.map(([k, v]) => {
      if (isPlainObject(v) && Object.keys(v).length > 0) {
        return `${pad}${k}:\n${toYamlLines(v, indent + 1)}`;
      }
      if (Array.isArray(v) && v.length > 0) {
        return `${pad}${k}:\n${toYamlLines(v, indent + 1)}`;
      }
      if (isPlainObject(v)) return `${pad}${k}: {}\n`;
      if (Array.isArray(v)) return `${pad}${k}: []\n`;
      return `${pad}${k}: ${yamlScalar(v)}\n`;
    }).join('');
  }
  return `${pad}${yamlScalar(value)}\n`;
}

/** Serialize a plain JSON-shaped value to a YAML document string. */
export function toYaml(value: Record<string, unknown>): string {
  return toYamlLines(value, 0);
}

const ARCH_MODEL_FLAGS: Record<AiToolkitArch, Record<string, unknown>> = {
  flux: { is_flux: true, quantize: true },
  sdxl: { is_xl: true },
  sd35: { is_v3: true },
  other: {},
};

// flowmatch models (Flux, SD3.5) need `noise_scheduler: flowmatch` +
// bf16; SDXL/other fall back to TrainConfig's own defaults (ddpm / fp32) —
// fp16 is used here instead of fp32 purely to keep VRAM/step time down,
// which is the same trade-off ai-toolkit's own SDXL community configs make.
function trainDefaultsForArch(arch: AiToolkitArch): { noiseScheduler?: string; dtype: string } {
  switch (arch) {
    case 'flux': return { noiseScheduler: 'flowmatch', dtype: 'bf16' };
    case 'sd35': return { noiseScheduler: 'flowmatch', dtype: 'bf16' };
    default: return { dtype: 'fp16' };
  }
}

/** Build the `run.py`-ready config object (pre-YAML-serialization). */
export function buildAiToolkitConfig(input: AiToolkitTrainConfigInput): Record<string, unknown> {
  const rank = input.rank;
  const alpha = input.alpha ?? rank;
  const trainDefaults = trainDefaultsForArch(input.arch);

  const process: Record<string, unknown> = {
    type: 'sd_trainer',
    training_folder: input.trainingFolder,
    device: 'cuda:0',
    ...(input.triggerWord ? { trigger_word: input.triggerWord } : {}),
    network: {
      type: 'lora',
      linear: rank,
      linear_alpha: alpha,
    },
    save: {
      dtype: 'float16',
      save_every: input.saveEvery,
      max_step_saves_to_keep: 4,
    },
    datasets: [
      {
        folder_path: input.datasetDir,
        caption_ext: 'txt',
        caption_dropout_rate: 0.05,
        shuffle_tokens: false,
        cache_latents_to_disk: true,
        resolution: [input.resolution],
      },
    ],
    train: {
      batch_size: input.batchSize,
      steps: input.steps,
      gradient_accumulation_steps: 1,
      train_unet: true,
      train_text_encoder: false,
      gradient_checkpointing: true,
      ...(trainDefaults.noiseScheduler ? { noise_scheduler: trainDefaults.noiseScheduler } : {}),
      optimizer: 'adamw8bit',
      lr: input.learningRate,
      // No sample-prompts UI yet — disable in-training sample generation so
      // a job never blocks on (or needs) a `sample:` block. See this file's
      // header comment: SampleConfig tolerates an absent block fine, but
      // *enabling* sampling without prompts would just generate empty-prompt
      // images every `sample_every` steps, wasting GPU time for no benefit.
      disable_sampling: true,
      dtype: trainDefaults.dtype,
    },
    model: {
      name_or_path: input.baseModelPath,
      ...ARCH_MODEL_FLAGS[input.arch],
      ...(input.lowVram ? { low_vram: true } : {}),
    },
  };

  return {
    job: 'extension',
    config: {
      name: input.jobName,
      process: [process],
    },
    meta: {
      name: '[name]',
      version: '1.0',
    },
  };
}

/** Write the generated config to `<configsDir>/<jobId>.yaml`, returning the
 *  absolute path passed to `run.py`. */
export function writeAiToolkitConfig(
  configsDir: string,
  jobId: string,
  input: AiToolkitTrainConfigInput,
): string {
  fs.mkdirSync(configsDir, { recursive: true, mode: 0o755 });
  const configPath = path.join(configsDir, `${jobId}.yaml`);
  const yamlText = toYaml(buildAiToolkitConfig(input));
  fs.writeFileSync(configPath, yamlText, 'utf-8');
  return configPath;
}

/**
 * Resolve the trained LoRA file `run.py` should have produced:
 * `<trainingFolder>/<jobName>/<jobName>.safetensors` (the final, un-stepped
 * save — see this file's header comment) if present, else the
 * highest-numbered `<jobName>_<9-digit-step>.safetensors` intermediate save.
 * Returns null if neither exists (training failed before any save).
 */
export function resolveTrainedLoraPath(trainingFolder: string, jobName: string): string | null {
  const saveRoot = path.join(trainingFolder, jobName);
  const finalPath = path.join(saveRoot, `${jobName}.safetensors`);
  if (fs.existsSync(finalPath)) return finalPath;
  if (!fs.existsSync(saveRoot)) return null;
  const stepPrefix = `${jobName}_`;
  const candidates = fs.readdirSync(saveRoot)
    .filter((f) => f.startsWith(stepPrefix) && f.endsWith('.safetensors'))
    .sort();
  if (candidates.length === 0) return null;
  return path.join(saveRoot, candidates[candidates.length - 1]);
}
