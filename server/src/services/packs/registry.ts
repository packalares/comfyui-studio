// Static capability-pack registry.
//
// A "pack" bundles the pip deps + model downloads an optional heavy feature
// needs (ACE-Step music generation, AI-Toolkit LoRA training). This module
// only holds the DECLARATIVE shape — id, label, description, marker file,
// venv components, model downloads. Install-time orchestration lives in
// `./install.ts`; durable installed/version state lives in the `packs` DB
// table (`lib/db/packs.repo.ts`).
//
// Deps + models for `ace-step` were extracted from
// `/home/laurs/packalares/apps/ace-step-ui/Dockerfile` (read at the time this
// registry was authored — re-check that file if ace-step-ui's build changes).
// torch/torchvision/torchaudio are deliberately EXCLUDED from every
// component's `pipPackages`: comfy's base image already provides them, and
// pinning a second copy per-pack would risk two incompatible CUDA wheels
// fighting over the same interpreter. Every venv below is created with
// `--system-site-packages` (see `install.ts`'s `ensureVenvComponent`)
// specifically so it can still READ that shared torch/numpy without
// downloading its own ~3 GB copy.
//
// ---------------------------------------------------------------------------
// EVERY pack dependency lives in a dedicated venv — nothing installs to the
// shared `pip install --user` site (`~/.local`) any more. That site is FIRST
// on `sys.path` and is where comfy's own core deps (including torch) live;
// two packs pip-installing conflicting pins there (observed in production:
// ai-toolkit's numpy 1.26/transformers 5.5.3 vs. ace-step's numpy>=2/
// transformers 4.57 — installing one uninstalled the other's pins) is exactly
// the failure mode `VenvComponent` isolation exists to prevent. A pack
// declares one or more `VenvComponent`s; each gets its own venv directory,
// its own interpreter, and its own pip-installed site-packages that can never
// clobber another component's (or comfy's own) packages.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_LYRICS_SYSTEM_PROMPT } from '../ace/prompts.js';
import type { PackModelKind } from './modelPaths.js';

export type PackId = 'ace-step' | 'ai-toolkit';

export const PACK_IDS: readonly PackId[] = ['ace-step', 'ai-toolkit'] as const;

export function isPackId(id: string): id is PackId {
  return (PACK_IDS as readonly string[]).includes(id);
}

/**
 * One selectable model a pack can download. Replaces the old fixed
 * `{repo, dest}` pair (`ModelDownloadSpec`) — `dest` is no longer stored
 * statically here because it's now DERIVED (via `services/packs/
 * modelPaths.ts`'s `resolvePackModelDest`) from `kind` + the EFFECTIVE repo
 * (this default, or a per-install `repo_override` from the `pack_models`
 * DB table — see `lib/db/packModels.repo.ts`), so a repo override also
 * changes where the download lands.
 */
export interface PackModelDef {
  /** Stable id (e.g. `'xl-turbo'`) — used as the `pack_models.model_id` key
   *  and in the `POST/DELETE .../models/:modelId` routes. Never rename an
   *  existing id: DB rows and any in-flight UI state key on it. */
  id: string;
  /** Default HuggingFace repo id. A DB `repo_override` (see
   *  `pack_models.repo_override`) takes precedence when present. */
  repo: string;
  /**
   * Set when `repo` is a combined multi-model bundle and this entry is only
   * ONE subfolder of it — the motivating case is ACE-Step's 5Hz-LM 1.7B
   * checkpoint, which (confirmed against the installed `acestep` package's
   * `model_downloader.py`: `SUBMODEL_REGISTRY` maps `0.6B`/`4B` to their own
   * standalone repos, but `1.7B` has no such entry — it only ships inside
   * `MAIN_MODEL_REPO = "ACE-Step/Ace-Step1.5"`, confirmed via that repo's own
   * file tree) has no standalone HF repo of its own. When set,
   * `resolvePackModelDest` uses THIS as the on-disk leaf directory name
   * (instead of deriving one from `repo`) and `install.ts`'s `downloadModel`
   * scopes `snapshot_download` to just this subfolder via `allow_patterns`
   * rather than pulling the whole (much larger) combined repo.
   */
  repoSubfolder?: string;
  /** Short label the settings UI shows as the row title. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Approximate download size in GB — UI display only, never measured
   *  against or enforced on the real download. */
  sizeGb: number;
  /** Installed automatically as part of a full pack install UNLESS the user
   *  explicitly deselects it (`pack_models.selected = 0`). */
  default: boolean;
  /** Which destination subtree this model's download lands in — see
   *  `resolvePackModelDest`. */
  kind: PackModelKind;
}

/**
 * Some packs (ai-toolkit) don't ship real packaging metadata — no sdist/wheel,
 * just a `requirements.txt` at the repo root. For those, `pip install
 * git+...` either fails outright or silently resolves 0 deps. The correct
 * install shape is: shallow-clone the repo to a persistent location, then
 * `pip install -r requirements.txt` from inside that clone using the OWNING
 * component's venv interpreter. Declaring this on a `VenvComponent` tells
 * `install.ts` to run that sequence before (optionally) also installing any
 * flat `pipPackages` extras into the same venv.
 */
export interface GitRequirementsInstall {
  /** Git remote to shallow-clone (`git clone --depth 1 <repoUrl> <cloneDir>`). */
  repoUrl: string;
  /**
   * Persistent destination directory. Idempotent: if this already looks like
   * a git checkout (`.git` present), the clone step is skipped so re-installs
   * / restarts don't re-clone. Callers that need to invoke a script from the
   * clone (e.g. `services/aiToolkit/train.ts` running `run.py`) import this
   * same path rather than re-deriving it.
   */
  cloneDir: string;
}

/**
 * One isolated Python dependency set within a pack. Every pack dependency —
 * including what used to be a pack's flat top-level `pipPackages` — now lives
 * in a `VenvComponent`. `install.ts`'s `ensureVenvComponent` provisions a
 * dedicated venv (`python3 -m venv --system-site-packages <venvDir>`, so it
 * can read comfy's torch/numpy without downloading a second copy) and
 * pip-installs `pipPackages` (and, if declared, `gitRequirementsInstall`'s
 * `requirements.txt`) into THAT venv's own interpreter — fully isolated from
 * every other component, including other components of the same pack.
 *
 * IndexTTS2 is the motivating case for splitting a pack into multiple
 * components: upstream pins torch==2.8/transformers==4.52/numpy==1.26,
 * incompatible with ACE-Step's own torch/transformers pins. `ace-step`
 * therefore declares TWO components — `main` (ace-step itself + training +
 * stem separation + whisper + lyrics LLM) and `indextts2` (voice-cloned TTS)
 * — each in its own venv so neither's pins can touch the other's.
 */
export interface VenvComponent {
  /** Short id (e.g. `'main'`, `'indextts2'`) — used in marker filenames and
   *  looked up via `getVenvComponent(packId, id)` by callers that need this
   *  venv's interpreter (e.g. `services/ace/indextts2.ts`). Every pack has at
   *  least a `'main'` component. */
  id: string;
  /** Human label surfaced in install progress messages and error text. */
  label: string;
  /** Persistent venv directory `install.ts` creates with
   *  `python3 -m venv --system-site-packages`. */
  venvDir: string;
  /** `<venvDir's python> -m pip install` argv tail — installed into THIS
   *  venv only, never any shared site. */
  pipPackages: string[];
  /** See `GitRequirementsInstall`. Set when this component's deps come from
   *  a repo's `requirements.txt` rather than (or in addition to) flat
   *  `pipPackages` entries — ai-toolkit's `main` component is the motivating
   *  case (no real packaging metadata to `pip install git+...` against). */
  gitRequirementsInstall?: GitRequirementsInstall;
  /**
   * Pin this component to a specific CPython version. When set, the venv is
   * created with `uv venv --python <version>` instead of `python3 -m venv`;
   * uv downloads a standalone interpreter of that version if the host doesn't
   * have one (verified: it fetches cpython-3.11.15 on this image, which ships
   * only 3.12.13).
   *
   * IndexTTS2 is the motivating case — its `requires-python` is
   * `>=3.10,<3.12`, so installing it under the image's Python 3.12 fails
   * outright with "Package 'indextts' requires a different Python: 3.12.13
   * not in '<3.12,>=3.10'". ace-step-ui hit the same wall and solved it the
   * same way (uv-managed venv — see its Dockerfile's `uv sync` step).
   *
   * NOTE: a version-pinned venv is deliberately created WITHOUT
   * `--system-site-packages`. Comfy's shared site-packages are built for
   * 3.12 and are ABI-incompatible with a 3.11 interpreter, so such a
   * component must install its own full dependency set (torch included).
   */
  pythonVersion?: string;
  /**
   * Sentinel file marking a successful venv provision. Independent from
   * `PackDefinition.markerFile` so re-running `installPack` after the pack
   * itself is already marked installed still provisions a component added by
   * a later revision (no need to bump the pack's own marker version).
   */
  markerFile: string;
}

/**
 * Declarative metadata for one `pack_settings` key (see `lib/db/
 * packModels.repo.ts`'s generic k/v table) — lets `PackSettings.tsx` render
 * a labeled, documented picker instead of a raw key/value row for settings
 * we know about ahead of time. A setting with no matching `PackSettingDef`
 * still round-trips fine (`getPackSettingsView`'s `settings` map is
 * unfiltered) — the UI just falls back to a plain row for it.
 */
export interface PackSettingDef {
  /** `pack_settings.key` this describes (e.g. `'llm.lyricsModel'`). */
  key: string;
  /** Short label the settings UI shows as the row title. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Longer guidance shown in an info tooltip — good-choice suggestions,
   *  what happens when the setting is left unset, etc. */
  tooltip: string;
  /** Picker shape: `'ollama-model'` renders a dropdown of `GET /chat/models`
   *  (installed Ollama models) with a link to the Ollama models page to pull
   *  more; `'text'` is a plain text input. */
  kind: 'ollama-model' | 'text' | 'textarea';
  /** Placeholder shown when the setting is unset. */
  placeholder?: string;
  /** For `textarea`: the code-level default this setting overrides. Shown as
   *  the initial content and restored by the UI's Reset button, so a user can
   *  always get back to the shipped prompt after editing it. */
  defaultValue?: string;
}

export interface PackDefinition {
  id: PackId;
  label: string;
  description: string;
  /**
   * Sentinel file written after every venv component + model download
   * succeeds; its presence lets the UI/DB treat the pack as fully installed.
   * Component-level idempotency (`VenvComponent.markerFile`) is what
   * actually short-circuits repeat `pip install` work on re-runs — this
   * marker is pack-level bookkeeping only.
   */
  markerFile: string;
  /** Every Python dependency this pack needs, isolated into one or more
   *  dedicated venvs — see `VenvComponent`. Always has at least one entry
   *  (conventionally id `'main'`). */
  venvComponents: VenvComponent[];
  /** Every model this pack CAN download. Not every entry installs on a full
   *  pack install — only `default: true` entries do (plus anything the user
   *  explicitly selected via `PATCH /packs/:id/settings` — see
   *  `services/packs/settings.ts`). */
  models: PackModelDef[];
  /** Documented `pack_settings` keys this pack reads — see `PackSettingDef`.
   *  Optional; defaults to none (a pack with no free-form settings). */
  settingDefs?: PackSettingDef[];
}

/** `<venvDir>/bin/python` — the interpreter a `VenvComponent`'s deps are
 *  installed into. Single source of truth: `install.ts` uses this to
 *  provision, callers (e.g. `services/ace/indextts2.ts`) use it to resolve
 *  the interpreter to spawn. */
export function venvPythonBin(component: VenvComponent): string {
  return path.join(component.venvDir, 'bin', 'python');
}

/** `<venvDir>/bin/<bin>` — a console-script entry point installed into a
 *  `VenvComponent`'s own venv (e.g. `audio-separator`). Spawning this
 *  directly (rather than relying on the bare command name being on `PATH`)
 *  guarantees the isolated venv's copy runs, not whatever the shared
 *  environment happens to expose. */
export function venvBinPath(component: VenvComponent, bin: string): string {
  return path.join(component.venvDir, 'bin', bin);
}

/** Look up a declared `VenvComponent` by pack + component id. Returns
 *  `undefined` if the pack has no such component (or doesn't exist). */
export function getVenvComponent(packId: PackId, componentId: string): VenvComponent | undefined {
  return PACKS[packId]?.venvComponents?.find((c) => c.id === componentId);
}

/**
 * Resolve a declared `VenvComponent`, requiring that its venv has actually
 * been provisioned on disk (not just declared). Throws a clear, actionable
 * error — naming the pack and the feature that needs it — rather than
 * letting a caller spawn a missing interpreter and surface a raw
 * `ENOENT`/`ImportError` deep inside a child process.
 */
function requireVenvComponent(packId: PackId, componentId: string, featureLabel: string): VenvComponent {
  const component = getVenvComponent(packId, componentId);
  const venvPython = component ? venvPythonBin(component) : undefined;
  if (component && venvPython && fs.existsSync(venvPython)) return component;
  const packLabel = PACKS[packId]?.label ?? packId;
  throw new Error(
    `${featureLabel} is unavailable: its dedicated Python venv`
    + (venvPython ? ` (${venvPython})` : '')
    + ` was not found. Install the ${packLabel} pack to enable ${featureLabel}.`,
  );
}

/**
 * Resolve the interpreter a runtime should spawn for `featureLabel`, sourced
 * from `packId`'s `componentId` venv. This is the single resolution point
 * every consumer (`services/aceStep/process.ts`, `services/ace/indextts2.ts`,
 * `services/ace/audioSeparator.ts`, `routes/ace/lyrics.routes.ts`,
 * `services/aiToolkit/train.ts`) should use instead of a bare `'python3'` or
 * a hardcoded path — see those files for operator-override precedence (some
 * still honor an explicit env var override ahead of calling this).
 */
export function resolvePackPython(packId: PackId, componentId: string, featureLabel: string): string {
  return venvPythonBin(requireVenvComponent(packId, componentId, featureLabel));
}

/** Like `resolvePackPython`, but resolves a console-script entry point
 *  (e.g. `audio-separator`) installed into the component's venv instead of
 *  the venv's `python` itself. */
export function resolveVenvBin(packId: PackId, componentId: string, bin: string, featureLabel: string): string {
  return venvBinPath(requireVenvComponent(packId, componentId, featureLabel), bin);
}

// Persistent volume root. Packs persist alongside pip's `--user` site
// (`~/.local`) so both survive image rebuilds / pod restarts on the same
// volume mount. Resolves to `/root/.local` in the container (root's homedir),
// matching the example in the pack design doc.
const PY_USER_BASE = path.join(os.homedir(), '.local');

// Where a pack's pip-installed venvs + git source checkouts live on the
// persistent volume. Deliberately NOT where downloaded MODELS live any more
// — see `services/packs/modelPaths.ts`'s header for why (comfy's own catalog
// scanner never looked here, so pack models were invisible to the Models
// page and to workflows). Models resolve their destination via
// `resolvePackModelDest` instead; this root is package-manager-owned install
// state only (venvs, git clones) now.
const PACKS_MODELS_ROOT = path.join(PY_USER_BASE, 'share', 'comfy-packs');

function markerFor(id: PackId, version: string): string {
  return path.join(PY_USER_BASE, `.pack-${id}-${version}`);
}

/** Marker naming for a `VenvComponent` — separate namespace from
 *  `markerFor` so a component's provisioning state is independent of
 *  (doesn't require bumping) the owning pack's own marker version. */
function venvMarkerFor(packId: PackId, componentId: string, version: string): string {
  return path.join(PY_USER_BASE, `.pack-${packId}-venv-${componentId}-${version}`);
}

// Persistent venv for ACE-Step's main dependency set (ace-step itself,
// training stack, stem separation, whisper, lyrics LLM — everything except
// IndexTTS2, see below). Exported implicitly via `getVenvComponent('ace-step',
// 'main')` — callers resolve through `resolvePackPython`/`resolveVenvBin`
// rather than importing this constant directly.
const ACE_STEP_MAIN_VENV_DIR = path.join(PACKS_MODELS_ROOT, 'ace-step', 'main-venv');

// Persistent venv for IndexTTS2 — see `VenvComponent`'s doc comment for why
// it can't share the pack's `main` component's venv. Exported so
// `services/ace/indextts2.ts` can resolve the interpreter without
// re-deriving the path (same single-source-of-truth pattern as
// `AI_TOOLKIT_DIR` below).
const ACE_INDEXTTS2_VENV_DIR = path.join(PACKS_MODELS_ROOT, 'ace-step', 'indextts2-venv');

// ostris/ai-toolkit's persistent SOURCE checkout (as opposed to
// PACKS_MODELS_ROOT, which is for downloaded model WEIGHTS). comfy needs the
// actual repo on disk to invoke `run.py <config>` at train time —
// `services/aiToolkit/train.ts` imports this constant directly rather than
// re-deriving the path, so the clone destination has exactly one source of
// truth.
export const AI_TOOLKIT_DIR = path.join(PACKS_MODELS_ROOT, 'ai-toolkit', 'src');

// Persistent venv for ai-toolkit's `main` component — its ENTIRE dependency
// set (installed from its own `requirements.txt` via `gitRequirementsInstall`
// below).
const AI_TOOLKIT_MAIN_VENV_DIR = path.join(PACKS_MODELS_ROOT, 'ai-toolkit', 'main-venv');

export const PACKS: Record<PackId, PackDefinition> = {
  'ace-step': {
    id: 'ace-step',
    label: 'Music (ACE-Step)',
    description:
      'ACE-Step 1.5 music generation: text-to-song, lyric-aware DiT decoder, '
      + 'voice-cloned TTS (IndexTTS2), multilingual lyric transcription '
      + '(faster-whisper), and stem separation (audio-separator).',
    // v1 -> v2: v1 installed the deps below into the SHARED `--user` site,
    // which is what let ai-toolkit's and ace-step's conflicting pins
    // uninstall each other in production (see this file's header comment).
    // v2 moves them into a dedicated `main` venv component instead. Any pod
    // that "successfully" installed v1 needs to re-run through the venv path.
    markerFile: markerFor('ace-step', 'v2'),
    venvComponents: [
      {
        id: 'main',
        label: 'ACE-Step (music generation, training, stems, whisper, lyrics LLM)',
        venvDir: ACE_STEP_MAIN_VENV_DIR,
        pipPackages: [
          // ACE-Step 1.5 itself, editable-from-git (matches the Dockerfile's
          // `pip install --no-deps -e /app/ACE-Step-1.5` after a shallow
          // clone — pip supports installing straight from a git URL without
          // a local clone step first).
          'ace-step @ git+https://github.com/ace-step/ACE-Step-1.5.git',
          // ACE-Step's nano-vllm vendor dep (installed editable from inside
          // the ACE-Step-1.5 checkout in the Dockerfile). Pip can't reach a
          // subdirectory of a git repo without PEP 508 `#subdirectory=`, so
          // this needs the same treatment as the ace-step line above.
          'nano-vllm @ git+https://github.com/ace-step/ACE-Step-1.5.git#subdirectory=acestep/third_parts/nano-vllm',
          // Training stack ACE-Step's LoRA trainer (python/acestep_patches/trainer.py
          // in ace-step-ui) depends on: Lightning Fabric-based trainer + LoRA
          // adapters + TensorBoard logging.
          'peft',
          'pytorch_lightning',
          'tensorboardX',
          // Video/audio decoding used by ACE-Step's inference pipeline.
          'torchcodec==0.10.0',
          // Torch 2.10 ships triton 2.3.1 by default; modern transformers routes
          // through torch._inductor which needs triton 3.x's compiler submodule.
          'triton>=3.0',
          // NOTE: `llama-cpp-python` (a second, CPU-only local-GGUF LLM stack)
          // used to live here for lyrics generation. Retired — lyrics + prompt
          // suggestions now go through comfy's existing ollama integration
          // (`services/ace/ollamaAssist.ts`, `routes/llm.routes.ts`) instead
          // of duplicating LLM infra. See `data/ace/lyrics_generate.py`'s
          // header for the superseded script.
          // Server-side stem extraction — BS/Mel-Roformer + Demucs + MDX in one CLI.
          'audio-separator[gpu]==0.44.1',
          // Multilingual lyric transcription (ACE-Step's own 5Hz LM only covers
          // English/Chinese well).
          'faster-whisper',
          // faster-whisper's CTranslate2 backend needs standalone CUDA 12 cuBLAS
          // + cuDNN even on a CUDA 13 base image (documented upstream workaround).
          // These land inside THIS venv's site-packages now (not the shared
          // `~/.local` site) — `services/ace/audioSeparator.ts`'s
          // `resolveCuda12LibPaths()` searches this venv's `lib/pythonX.Y/
          // site-packages/nvidia/{cublas,cudnn}/lib` accordingly.
          'nvidia-cublas-cu12',
          'nvidia-cudnn-cu12',
          // flash-attn: the Dockerfile installs a CUDA/torch/python-version-
          // specific prebuilt wheel (cu130+torch2.10+cp311) rather than building
          // from source (`pip install flash-attn` alone takes 30+ min to compile
          // and frequently OOMs). Whether that exact wheel URL applies here
          // depends on comfy's base image CUDA/Python/torch versions.
          // TODO: confirm comfy's CUDA/torch/Python versions match this wheel's
          // build tag before shipping; otherwise resolve a matching wheel from
          // https://github.com/mjun0812/flash-attention-prebuild-wheels or fall
          // back to a source build (slow, needs `ninja` + a working nvcc).
          'flash-attn',
        ],
        markerFile: venvMarkerFor('ace-step', 'main', 'v1'),
      },
      {
        id: 'indextts2',
        label: 'IndexTTS2 (voice-cloned TTS)',
        venvDir: ACE_INDEXTTS2_VENV_DIR,
        // IndexTTS2's `requires-python` is `>=3.10,<3.12`. This image ships
        // only Python 3.12.13, so a plain `python3 -m venv` install dies with
        // "Package 'indextts' requires a different Python: 3.12.13 not in
        // '<3.12,>=3.10'". Pinning the version makes `install.ts` provision
        // the venv with `uv venv --python 3.11`, which downloads a standalone
        // CPython 3.11 (verified on this image: fetches cpython-3.11.15).
        pythonVersion: '3.11',
        pipPackages: [
          // Upstream explicitly refuses pip support and recommends `uv` —
          // but a plain venv + pip works fine once isolated from ACE-Step's
          // own torch/transformers pins (the whole reason this needs its
          // own component/venv, not just its own pip line). Installed with
          // deps (no `--no-deps`) so torch==2.8/transformers==4.52/
          // numpy==1.26 resolve inside this venv only.
          // The distribution name is `indextts` (NOT `index-tts2`, which is
          // just the project's marketing name). A PEP 508 direct reference
          // must use the real name or pip rejects the build with
          // "has inconsistent name: expected 'index-tts2', but metadata has
          // 'indextts'".
          'indextts @ git+https://github.com/index-tts/index-tts.git',
        ],
        markerFile: venvMarkerFor('ace-step', 'indextts2', 'v2'),
      },
    ],
    models: [
      // CONFIRMED against the installed `acestep` package's own repo-id
      // constants (grepped from site-packages after the main venv was
      // provisioned) and verified reachable+public via the HF API. The
      // earlier guesses ("ACE-Step/ACE-Step-v1.5-xl-turbo") 401'd — the real
      // convention is lowercase/undotted `acestep-v15-*`, matching the model
      // ids ace-step-ui uses in data/models.ts.
      //
      // ACE-Step 1.5 is a two-stage DiT + 5Hz-LM architecture; the DiT
      // checkpoints above are only half of it. The 5Hz LM repo ids below were
      // grepped from the installed `acestep` package and each verified
      // reachable (HTTP 200 on `https://huggingface.co/api/models/<repo>`,
      // `transformers`/`safetensors`/`Qwen3ForCausalLM`) before being added —
      // three earlier repo-id guesses elsewhere in this file already cost a
      // code-change -> sync -> retry cycle apiece, not repeating that here.
      // Pre-downloading these means a generation doesn't stall on a cold LM
      // fetch the first time a user hits Generate.
      //
      // `lm-1.7b` is the one that defaults on — see the comment above its
      // entry below for why (GPU-tier reasoning: this deployment's card sits
      // in ACE-Step's own `tier6b` bracket, which recommends 1.7B, not the
      // smaller 0.6B this registry used to default to). `lm-0.6b`/`lm-4b`
      // stay available for the user to select explicitly.
      {
        id: 'lm-0.6b',
        repo: 'ACE-Step/acestep-5Hz-lm-0.6B',
        label: 'ACE-Step 5Hz LM 0.6B',
        description: 'Smallest/fastest half of the two-stage DiT + 5Hz-LM architecture — good for <=16GB cards.',
        sizeGb: 2,
        default: false,
        kind: 'lm',
      },
      // No standalone HF repo — see `PackModelDef.repoSubfolder`'s doc
      // comment. Size CONFIRMED via the `ACE-Step/Ace-Step1.5` repo's file
      // tree (huggingface.co/ACE-Step/Ace-Step1.5/tree/main/
      // acestep-5Hz-lm-1.7B): 3.76 GB, almost entirely one
      // `model.safetensors` shard — rounded up to 4 for the whole-GB display
      // convention every other entry here uses.
      //
      // DEFAULT CHOICE: this GPU reports 24463 MiB (~23.9 GB) — under the
      // 24 GB floor of ACE-Step's own `gpu_config.py` `unlimited` tier (which
      // recommends the 4B LM) but inside its `tier6b` (20-24 GB) bracket,
      // which recommends THIS model. The registry previously defaulted to
      // `lm-0.6b` (sized for <=16 GB cards) — changed here to match what
      // ACE-Step itself would pick for this hardware, not silently kept for
      // "it was already the default".
      {
        id: 'lm-1.7b',
        repo: 'ACE-Step/Ace-Step1.5',
        repoSubfolder: 'acestep-5Hz-lm-1.7B',
        label: 'ACE-Step 5Hz LM 1.7B',
        description: 'Mid-size LM backend — ACE-Step\'s own recommended default for 20-24GB GPUs (this deployment\'s tier).',
        sizeGb: 4,
        default: true,
        kind: 'lm',
      },
      {
        id: 'lm-4b',
        repo: 'ACE-Step/acestep-5Hz-lm-4B',
        label: 'ACE-Step 5Hz LM 4B',
        description: 'Largest/highest-quality LM backend — ACE-Step\'s recommended pick for >=24GB GPUs. Optional here.',
        sizeGb: 9,
        default: false,
        kind: 'lm',
      },
      // Only `xl-turbo` defaults on: it's the fast/few-step checkpoint most
      // generations use. `xl-sft` / `xl-base` are ~19 GB each and rarely
      // needed (production incident this registry shape fixes: all three
      // downloaded unconditionally before this — one of them alongside a
      // 9.3 GB checkpoint of the same model the box ALREADY had under
      // `models/diffusion_models/`).
      {
        id: 'xl-turbo',
        repo: 'ACE-Step/acestep-v15-xl-turbo',
        label: 'ACE-Step 1.5 XL Turbo',
        description: 'Distilled few-step DiT checkpoint — the default for text-to-song generation.',
        sizeGb: 19,
        default: true,
        kind: 'checkpoint',
      },
      {
        id: 'xl-sft',
        repo: 'ACE-Step/acestep-v15-xl-sft',
        label: 'ACE-Step 1.5 XL SFT',
        description: 'Supervised fine-tuned checkpoint — higher fidelity, more sampling steps. Rarely needed alongside xl-turbo.',
        sizeGb: 19,
        default: false,
        kind: 'checkpoint',
      },
      {
        id: 'xl-base',
        repo: 'ACE-Step/acestep-v15-xl-base',
        label: 'ACE-Step 1.5 XL Base',
        description: 'Base (non-distilled) checkpoint — mainly a fine-tuning starting point, not needed for normal generation.',
        sizeGb: 19,
        default: false,
        kind: 'checkpoint',
      },
      {
        id: 'whisper-large-v3',
        // Confirmed repo id — matches the Dockerfile's snapshot_download call verbatim.
        repo: 'Systran/faster-whisper-large-v3',
        label: 'Whisper Large v3 (faster-whisper)',
        description: 'Multilingual lyric transcription used when building training datasets.',
        sizeGb: 3,
        default: true,
        kind: 'whisper',
      },
      {
        id: 'indextts2',
        // Confirmed repo id — matches the Dockerfile's `hf download IndexTeam/IndexTTS-2` call.
        repo: 'IndexTeam/IndexTTS-2',
        label: 'IndexTTS2',
        description: 'Voice-cloned TTS weights.',
        sizeGb: 8,
        default: true,
        kind: 'tts',
      },
    ],
    // Two SEPARATE model choices (deliberately not one shared setting):
    // lyrics need a stronger model than a one-line prompt idea does, and the
    // user should be able to pick a fast model for the latter without
    // paying its cost on every lyrics generation too. Both resolve through
    // `services/ace/ollamaAssist.ts`'s `resolveSuggestionModel`/
    // `resolveLyricsModel` — explicit override if still installed, else the
    // first Ollama-reported installed model, else `null` (caller degrades
    // to a local fallback; ACE-Step is never started to satisfy either).
    settingDefs: [
      // Generation-time model selection (see `routes/ace/generate.routes.ts`'s
      // `resolveEffectiveDitModel`/`resolveEffectiveLmModel`, which wire these
      // into `switchModel()`/`POST /v1/init` before every generation). Both
      // are optional fallbacks — a request's own `ditModel` field (the UI's
      // per-session picker, see `contracts/ace/generate.contract.ts`) always
      // wins when set; these only matter for requests that omit it (or a
      // fresh install with no explicit user choice yet).
      {
        key: 'generate.ditModel',
        label: 'Default DiT checkpoint',
        description: 'Music-generation checkpoint used when a request doesn\'t specify one explicitly.',
        tooltip: 'Directory name of an installed checkpoint (e.g. acestep-v15-xl-turbo) — see the pack\'s '
          + 'model list above. Unset falls back to the registry\'s `default: true` checkpoint (xl-turbo).',
        kind: 'text',
        placeholder: 'acestep-v15-xl-turbo',
      },
      {
        key: 'generate.lmModel',
        label: 'Default 5Hz-LM backend',
        description: 'ACE-Step\'s planning LM used when a request doesn\'t specify one explicitly.',
        tooltip: 'Directory name of an installed 5Hz-LM (e.g. acestep-5Hz-lm-1.7B) — same `checkpoints/` tree '
          + 'as the DiT checkpoints above (see modelPaths.ts). Unset falls back to the registry\'s `default: '
          + 'true` LM.',
        kind: 'text',
        placeholder: 'acestep-5Hz-lm-1.7B',
      },
      {
        key: 'llm.suggestionModel',
        label: 'Prompt-suggestion model',
        description: 'Ollama model used for one-line Simple-mode song-idea suggestions ("Surprise me").',
        tooltip: 'Fast/small (3B-class) instruct model — e.g. llama3.2:3b or qwen2.5:3b. '
          + 'Unset falls back to whatever Ollama has installed (first model `ollama list` reports).',
        kind: 'ollama-model',
        placeholder: 'Follow Ollama default',
      },
      {
        key: 'llm.lyricsModel',
        label: 'Lyrics-generation model',
        description: 'Ollama model used to write full song lyrics with [verse]/[chorus] section tags.',
        tooltip: 'Larger/stronger instruct model (8B+) for better lyric quality — e.g. llama3.1:8b or qwen2.5:14b. '
          + 'Unset falls back to whatever Ollama has installed (first model `ollama list` reports).',
        kind: 'ollama-model',
        placeholder: 'Follow Ollama default',
      },
      {
        key: 'lyrics.systemPrompt',
        label: 'Lyrics writing style',
        description: 'Instructions given to the lyrics model. Edit to change how lyrics are written.',
        tooltip: 'Keep the [verse]/[chorus] structure tags — ACE-Step\'s lyric encoder uses them to align '
          + 'sections with the music, so removing them degrades the result. Everything else (tone, imagery, '
          + 'rhyme, language rules, song structure) is yours to change. Leave blank to use the shipped default.',
        kind: 'textarea',
        placeholder: 'Using the built-in songwriting prompt',
        defaultValue: DEFAULT_LYRICS_SYSTEM_PROMPT,
      },
    ],
  },
  'ai-toolkit': {
    id: 'ai-toolkit',
    label: 'Image LoRA Training',
    description: 'ostris/ai-toolkit — LoRA / fine-tune training for image diffusion models (Flux, SDXL, SD3.5, ...).',
    // v2 -> v3: v2 installed ai-toolkit's requirements.txt into the SHARED
    // `--user` site (see this file's header comment for the production
    // fallout of that). v3 moves the install into a dedicated `main` venv
    // component instead — same treatment as ace-step's v1 -> v2 bump. Any pod
    // that "successfully" installed v1/v2 needs to re-run through the venv path.
    markerFile: markerFor('ai-toolkit', 'v3'),
    venvComponents: [
      {
        id: 'main',
        label: 'ai-toolkit (LoRA trainer)',
        venvDir: AI_TOOLKIT_MAIN_VENV_DIR,
        // No flat pip packages — ai-toolkit's entire dependency set comes
        // from its own requirements.txt via gitRequirementsInstall below.
        // torch is still excluded there too (requirements.txt doesn't pin
        // it; the venv's `--system-site-packages` flag lets it see comfy's
        // base-image torch as-is).
        pipPackages: [],
        gitRequirementsInstall: {
          repoUrl: 'https://github.com/ostris/ai-toolkit.git',
          cloneDir: AI_TOOLKIT_DIR,
        },
        markerFile: venvMarkerFor('ai-toolkit', 'main', 'v1'),
      },
    ],
    models: [
      // ai-toolkit trains against user-supplied base checkpoints (local file
      // or a HuggingFace repo id resolved at train time — see
      // `services/aiToolkit/config.ts`) rather than shipping its own fixed
      // model, so there's no fixed list to pre-download here.
    ],
  },
};

export function getPack(id: string): PackDefinition | null {
  return isPackId(id) ? PACKS[id] : null;
}

export function listPackDefinitions(): PackDefinition[] {
  return PACK_IDS.map((id) => PACKS[id]);
}

/**
 * Look up one declared `PackModelDef` by pack + model id. Every route that
 * takes a `:modelId` from the client MUST validate against this (never
 * trust an arbitrary id straight from the URL into a filesystem path) —
 * see `routes/packs.routes.ts`'s model-download/remove routes.
 */
export function getPackModel(packId: string, modelId: string): PackModelDef | null {
  const pack = getPack(packId);
  if (!pack) return null;
  return pack.models.find((m) => m.id === modelId) ?? null;
}
