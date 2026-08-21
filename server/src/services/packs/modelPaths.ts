// Destination resolution for capability-pack MODEL downloads (as opposed to
// pip venvs / git source checkouts — those stay under `registry.ts`'s
// `PACKS_MODELS_ROOT`, `~/.local/share/comfy-packs/**`, untouched by this
// file).
//
// PRODUCTION INCIDENT this fixes: pack models used to download into
// `PACKS_MODELS_ROOT` too, a tree comfy's own catalog scanner
// (`services/catalog/folderRegistry.ts`) never looks at — it only walks
// `/root/ComfyUI/models/*` (or wherever ComfyUI is actually configured to
// look, via `extra_model_paths.yaml`). Result: downloaded pack models were
// invisible to the Models page AND to workflows. This module makes pack
// models land inside comfy's own managed models tree instead, so they're
// visible the same way any manually-downloaded checkpoint is.
//
// Two different placements, by shape:
//
//   1. ACE-Step's DiT checkpoints / faster-whisper / IndexTTS2 are each a
//      multi-file HuggingFace snapshot (config.json, tokenizer files,
//      several .safetensors/.bin shards, ...) — not the single .safetensors
//      file ComfyUI's typed folders (`diffusion_models`, `checkpoints`, ...)
//      expect one entry per file to be. Dropping a whole HF repo tree into
//      one of those would make every shard/config show up as its own
//      "model" in comfy's listing. So these get their own `ace-step/`
//      subtree under the models root instead of polluting a typed folder.
//
//   2. The lyrics LLM (a single-file quantized GGUF, if/when this pack ships
//      one — see `kind: 'llm'` below) is the opposite case: exactly what
//      ComfyUI's own `LLM` typed folder is for, so it gets a normal
//      typed-folder placement, not a subtree.
//
// Root derivation deliberately never hardcodes `/root/ComfyUI` (see
// `services/aiToolkit/lorasDir.ts`, which resolves `models/loras` the same
// way): prefer the live `folderRegistry` cache of ComfyUI's actual
// `/api/experiment/models` response (handles `extra_model_paths.yaml`
// remaps), falling back to `env.COMFYUI_PATH` — the same fallback every
// other service in this codebase uses when ComfyUI hasn't reported in yet.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { getPathsForFolder } from '../catalog/folderRegistry.js';
import { safeResolve } from '../../lib/fs.js';

export type PackModelKind = 'checkpoint' | 'whisper' | 'tts' | 'llm' | 'lm';

/**
 * Root of ComfyUI's managed models tree (`.../models`). Prefers the live
 * folderRegistry cache — any already-registered core folder's parent dir —
 * so a custom `extra_model_paths.yaml` remap is honoured; falls back to
 * `<COMFYUI_PATH>/models` when the registry hasn't loaded yet (e.g. this
 * runs before ComfyUI has been reached once, same situation
 * `lorasDir.ts`'s own fallback comment describes).
 */
export function resolveComfyModelsRoot(): string {
  for (const folder of ['checkpoints', 'diffusion_models', 'loras']) {
    const registered = getPathsForFolder(folder);
    if (registered.length > 0) return path.dirname(registered[0]);
  }
  return path.join(env.COMFYUI_PATH, 'models');
}

/** `<models root>/ace-step` — see this module's header for why ACE-Step's
 *  multi-file HF snapshots get their own subtree. */
export function resolveAceStepModelsRoot(): string {
  return path.join(resolveComfyModelsRoot(), 'ace-step');
}

/** ComfyUI's typed `LLM` folder — prefers the registered path (handles a
 *  custom_node or `extra_model_paths.yaml` alias), falls back to
 *  `<models root>/LLM`. */
export function resolveLlmModelsDir(): string {
  const registered = getPathsForFolder('llm');
  if (registered.length > 0) return registered[0];
  return path.join(resolveComfyModelsRoot(), 'LLM');
}

/** Last path segment of a HuggingFace repo id, used as the on-disk directory
 *  name for a downloaded snapshot (`ACE-Step/acestep-v15-xl-turbo` ->
 *  `acestep-v15-xl-turbo`). */
function repoDirName(repo: string): string {
  const last = repo.trim().split('/').filter(Boolean).pop();
  if (!last) throw new Error(`Cannot derive a directory name from repo id: ${repo}`);
  return last;
}

/**
 * Resolve the destination directory a pack model download should land in,
 * given its `kind` (registry-declared, drives WHICH subtree) and effective
 * `repo` (registry default or a user `repo_override` — always passed through
 * `safeResolve` here since a repo_override is user-supplied and must not be
 * able to escape the target root).
 *
 *   checkpoint -> <models>/ace-step/checkpoints/<repoName>/
 *   whisper    -> <models>/ace-step/whisper/<repoName>/
 *   tts        -> <models>/ace-step/indextts2/  (fixed name — this pack only
 *                 ever ships one TTS model; keeping the leaf name fixed
 *                 rather than repo-derived means the operator's one-time
 *                 `mv` from the old `~/.local/share/comfy-packs/ace-step/
 *                 indextts2` location needs no rename)
 *   llm        -> <models>/LLM/  (single-file GGUF; the download itself picks
 *                 the filename inside this dir — see hf_hub_download call
 *                 sites, none yet for this pack)
 *   lm         -> <models>/ace-step/checkpoints/<repoName>/  (ACE-Step's own
 *                 5Hz LM checkpoints — SAME directory as `checkpoint`, NOT a
 *                 separate `lm/` subtree. CONFIRMED on the live server:
 *                 ACE-Step resolves EVERY checkpoint, DiT and 5Hz-LM alike,
 *                 at `<project_root>/checkpoints/<name>` — its own
 *                 self-triggered downloads of `acestep-5Hz-lm-1.7B` and
 *                 `acestep-5Hz-lm-4B` landed flat inside `checkpoints/`,
 *                 alongside `acestep-v15-turbo`, never in a subfolder of
 *                 their own. This also matches the installed `acestep`
 *                 package's own `model_downloader.py`:
 *                 `MAIN_MODEL_COMPONENTS = ["acestep-v15-turbo", "vae",
 *                 "Qwen3-Embedding-0.6B", "acestep-5Hz-lm-1.7B"]` — all four
 *                 sit together as siblings. An earlier revision of this file
 *                 put `lm` in its own subtree, which meant ACE-Step could
 *                 never find a pack-downloaded LM and would silently
 *                 re-download its own copy into `checkpoints/` on every cold
 *                 start — exactly the duplication this pack's model-path
 *                 scheme exists to prevent.
 *
 *                 `lm` stays a DISTINCT `kind` from `checkpoint` even though
 *                 they now share a directory: `GET /ace/generate/models`
 *                 filters the DiT dropdown on the registry's `kind ===
 *                 'checkpoint'`, not on where the files happen to live, so a
 *                 5Hz-LM entry correctly stays out of that list regardless
 *                 of directory.
 *
 * `repoSubfolder` (see `PackModelDef.repoSubfolder`) overrides `<repoName>`
 * above with the subfolder name itself — used when `repo` is a combined
 * multi-model bundle and only one subfolder of it is this entry (ACE-Step's
 * 5Hz-LM 1.7B: no standalone repo, only a subfolder of `ACE-Step/Ace-Step1.5`).
 * This also happens to match the on-disk leaf name ACE-Step itself expects
 * under `<project_root>/checkpoints/<name>` for that checkpoint.
 */
export function resolvePackModelDest(kind: PackModelKind, repo: string, repoSubfolder?: string): string {
  const aceRoot = resolveAceStepModelsRoot();
  const leaf = repoSubfolder || repoDirName(repo);
  switch (kind) {
    // 'checkpoint' and 'lm' deliberately share this branch — see this
    // function's doc comment for why an LM lands in `checkpoints/` too.
    case 'checkpoint':
    case 'lm':
      return safeResolve(aceRoot, 'checkpoints', leaf);
    case 'whisper':
      return safeResolve(aceRoot, 'whisper', leaf);
    case 'tts':
      return safeResolve(aceRoot, 'indextts2');
    case 'llm':
      return resolveLlmModelsDir();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled pack model kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Best-effort check for "this model's files are already on disk".
 *
 * Lives here rather than in `install.ts` because both the installer (to skip
 * re-fetching multi-GB weights) and the settings view (to reconcile recorded
 * state against reality) need it, and `install.ts` already imports
 * `settings.ts` — putting it in either of those would create a cycle.
 *
 * Deliberately a shallow non-empty check, not a manifest/hash comparison:
 * good enough to avoid re-triggering a multi-GB network pull, consistent with
 * `huggingface_hub.snapshot_download` itself only being partially resumable,
 * not byte-verified, on repeat calls.
 */
export function looksDownloaded(dest: string): boolean {
  try {
    return fs.readdirSync(dest).length > 0;
  } catch {
    return false;
  }
}
