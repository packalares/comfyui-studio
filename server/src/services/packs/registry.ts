// Static capability-pack registry.
//
// A "pack" bundles the pip deps + model downloads an optional heavy feature
// needs (ACE-Step music generation, AI-Toolkit LoRA training). This module
// only holds the DECLARATIVE shape — id, label, description, marker file,
// pip packages, model downloads. Install-time orchestration lives in
// `./install.ts`; durable installed/version state lives in the `packs` DB
// table (`lib/db/packs.repo.ts`).
//
// Deps + models for `ace-step` were extracted from
// `/home/laurs/packalares/apps/ace-step-ui/Dockerfile` (read at the time this
// registry was authored — re-check that file if ace-step-ui's build changes).
// torch/torchvision/torchaudio are deliberately EXCLUDED: comfy's base image
// already provides them, and pinning a second copy per-pack would risk two
// incompatible CUDA wheels fighting over the same site-packages.

import os from 'os';
import path from 'path';

export type PackId = 'ace-step' | 'ai-toolkit';

export const PACK_IDS: readonly PackId[] = ['ace-step', 'ai-toolkit'] as const;

export function isPackId(id: string): id is PackId {
  return (PACK_IDS as readonly string[]).includes(id);
}

export interface ModelDownloadSpec {
  /** HuggingFace repo id (or repo id + revision) the model lives under. */
  repo: string;
  /** Absolute destination directory the model is downloaded into. */
  dest: string;
}

/**
 * Some packs (ai-toolkit) don't ship real packaging metadata — no sdist/wheel,
 * just a `requirements.txt` at the repo root. For those, `pip install
 * git+...` either fails outright or silently resolves 0 deps. The correct
 * install shape is: shallow-clone the repo to a persistent location, then
 * `pip install --user -r requirements.txt` from inside that clone. Declaring
 * this on a `PackDefinition` tells `install.ts` to run that sequence before
 * (optionally) also installing any flat `pipPackages` extras.
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
 * Some pack dependencies pin versions that conflict with the pack's own flat
 * `pipPackages` (installed into the shared `pip install --user` site — see
 * `PackDefinition.pipPackages`). IndexTTS2 is the motivating case: upstream
 * pins torch==2.8/transformers==4.52/numpy==1.26, incompatible with
 * ACE-Step's own torch/transformers pins in that same site. Declaring a
 * component here tells `install.ts` to provision a DEDICATED venv
 * (`python3 -m venv <venvDir>`) and pip-install `pipPackages` into that
 * venv's own interpreter — fully isolated from the shared site. Mirrors
 * ace-step-ui's Dockerfile, which stood up a dedicated uv-managed venv at
 * `/app/indextts-src/.venv` for the same reason.
 */
export interface VenvComponent {
  /** Short id (e.g. `'indextts2'`) — used in marker filenames and looked up
   *  via `getVenvComponent(packId, id)` by callers that need this venv's
   *  interpreter (e.g. `services/ace/indextts2.ts`). */
  id: string;
  /** Human label surfaced in install progress messages. */
  label: string;
  /** Persistent venv directory `install.ts` creates with `python3 -m venv`. */
  venvDir: string;
  /** `<venvDir's python> -m pip install` argv tail — installed into THIS
   *  venv only, never the pack's shared `--user` site. */
  pipPackages: string[];
  /**
   * Sentinel file marking a successful venv provision. Independent from
   * `PackDefinition.markerFile` so re-running `installPack` after the pack
   * itself is already marked installed still provisions a venv added by a
   * later revision (no need to bump the pack's own marker version).
   */
  markerFile: string;
}

export interface PackDefinition {
  id: PackId;
  label: string;
  description: string;
  /**
   * Sentinel file written after a successful install; its presence lets a
   * re-run of `installPack` short-circuit the pip step without re-running
   * multi-minute installs on every boot.
   */
  markerFile: string;
  /** `pip install --user` argv tail — one package spec per entry. */
  pipPackages: string[];
  models: ModelDownloadSpec[];
  /** See `GitRequirementsInstall`. Undefined for packs with real packaging
   *  metadata (installable via a plain `pipPackages` entry). */
  gitRequirementsInstall?: GitRequirementsInstall;
  /** Dependencies needing an isolated venv — see `VenvComponent`. */
  venvComponents?: VenvComponent[];
}

/** `<venvDir>/bin/python` — the interpreter a `VenvComponent`'s deps are
 *  installed into. Single source of truth: `install.ts` uses this to
 *  provision, callers (e.g. `services/ace/indextts2.ts`) use it to resolve
 *  the interpreter to spawn. */
export function venvPythonBin(component: VenvComponent): string {
  return path.join(component.venvDir, 'bin', 'python');
}

/** Look up a declared `VenvComponent` by pack + component id. Returns
 *  `undefined` if the pack has no such component (or doesn't exist). */
export function getVenvComponent(packId: PackId, componentId: string): VenvComponent | undefined {
  return PACKS[packId]?.venvComponents?.find((c) => c.id === componentId);
}

// Persistent volume root. Packs persist alongside pip's `--user` site
// (`~/.local`) so both survive image rebuilds / pod restarts on the same
// volume mount. Resolves to `/root/.local` in the container (root's homedir),
// matching the example in the pack design doc.
const PY_USER_BASE = path.join(os.homedir(), '.local');

// Where downloaded pack models live on the persistent volume. Provisional —
// TODO: once the ACE-Step integration (owned by another workstream, see
// `services/aceStep/*`) lands, confirm this matches whatever
// ACESTEP_CHECKPOINTS_PATH-equivalent env var it introduces, and switch the
// `dest` values below to point at it directly instead of this pack-local copy.
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

// Persistent venv for IndexTTS2 — see `VenvComponent`'s doc comment for why
// it can't share the pack's flat `pipPackages` site. Exported so
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

export const PACKS: Record<PackId, PackDefinition> = {
  'ace-step': {
    id: 'ace-step',
    label: 'Music (ACE-Step)',
    description:
      'ACE-Step 1.5 music generation: text-to-song, lyric-aware DiT decoder, '
      + 'voice-cloned TTS (IndexTTS2), multilingual lyric transcription '
      + '(faster-whisper), and stem separation (audio-separator).',
    markerFile: markerFor('ace-step', 'v1'),
    pipPackages: [
      // ACE-Step 1.5 itself, editable-from-git (matches the Dockerfile's
      // `pip install --no-deps -e /app/ACE-Step-1.5` after a shallow clone —
      // pip supports installing straight from a git URL without a local
      // clone step first).
      'ace-step @ git+https://github.com/ace-step/ACE-Step-1.5.git',
      // ACE-Step's nano-vllm vendor dep (installed editable from inside the
      // ACE-Step-1.5 checkout in the Dockerfile). Pip can't reach a
      // subdirectory of a git repo without PEP 508 `#subdirectory=`, so this
      // needs the same treatment as the ace-step line above.
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
      // Lyrics LLM (GGUF model inference).
      'llama-cpp-python',
      // Server-side stem extraction — BS/Mel-Roformer + Demucs + MDX in one CLI.
      'audio-separator[gpu]==0.44.1',
      // Multilingual lyric transcription (ACE-Step's own 5Hz LM only covers
      // English/Chinese well).
      'faster-whisper',
      // faster-whisper's CTranslate2 backend needs standalone CUDA 12 cuBLAS
      // + cuDNN even on a CUDA 13 base image (documented upstream workaround).
      'nvidia-cublas-cu12',
      'nvidia-cudnn-cu12',
      // IndexTTS2 (voice-cloned TTS) is deliberately NOT listed here — its
      // pinned deps (torch==2.8/transformers==4.52/numpy==1.26) conflict
      // with the versions above. It's installed into its own venv instead;
      // see `venvComponents` below.
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
    venvComponents: [
      {
        id: 'indextts2',
        label: 'IndexTTS2 (voice-cloned TTS)',
        venvDir: ACE_INDEXTTS2_VENV_DIR,
        pipPackages: [
          // Upstream explicitly refuses pip support and recommends `uv` —
          // but a plain venv + pip works fine once isolated from ACE-Step's
          // own torch/transformers pins (the whole reason this needs its
          // own venv). Installed with deps (no `--no-deps`) so torch==2.8/
          // transformers==4.52/numpy==1.26 resolve inside this venv only.
          'index-tts2 @ git+https://github.com/index-tts/index-tts.git',
        ],
        markerFile: venvMarkerFor('ace-step', 'indextts2', 'v1'),
      },
    ],
    models: [
      // TODO: these are best-effort HF repo ids inferred from the model
      // naming convention used throughout ace-step-ui (data/models.ts,
      // routes/generate.ts). ACE-Step's own `acestep.api.model_download`
      // module (vendored inside the ACE-Step-1.5 clone, not present in this
      // checkout) is the actual source of truth for the exact repo ids —
      // confirm against it once the `ace-step` pip package above is
      // installed and importable.
      { repo: 'ACE-Step/ACE-Step-v1.5-xl-turbo', dest: path.join(PACKS_MODELS_ROOT, 'ace-step', 'checkpoints', 'acestep-v15-xl-turbo') },
      { repo: 'ACE-Step/ACE-Step-v1.5-xl-sft', dest: path.join(PACKS_MODELS_ROOT, 'ace-step', 'checkpoints', 'acestep-v15-xl-sft') },
      { repo: 'ACE-Step/ACE-Step-v1.5-xl-base', dest: path.join(PACKS_MODELS_ROOT, 'ace-step', 'checkpoints', 'acestep-v15-xl-base') },
      // Confirmed repo id — matches the Dockerfile's snapshot_download call verbatim.
      { repo: 'Systran/faster-whisper-large-v3', dest: path.join(PACKS_MODELS_ROOT, 'ace-step', 'whisper-large-v3') },
      // Confirmed repo id — matches the Dockerfile's `hf download IndexTeam/IndexTTS-2` call.
      { repo: 'IndexTeam/IndexTTS-2', dest: path.join(PACKS_MODELS_ROOT, 'ace-step', 'indextts2') },
    ],
  },
  'ai-toolkit': {
    id: 'ai-toolkit',
    label: 'Image LoRA Training',
    description: 'ostris/ai-toolkit — LoRA / fine-tune training for image diffusion models (Flux, SDXL, SD3.5, ...).',
    // Bumped v1 -> v2: v1's marker corresponded to a broken bare
    // `pip install git+...` (ai-toolkit has no real packaging metadata, see
    // `GitRequirementsInstall`'s doc comment) that likely never actually
    // resolved ai-toolkit's dependencies. Any pod that "successfully"
    // installed v1 needs to re-run through the real clone+requirements path.
    markerFile: markerFor('ai-toolkit', 'v2'),
    // No flat pip packages — ai-toolkit's entire dependency set comes from
    // its own requirements.txt via gitRequirementsInstall below. torch is
    // still excluded there too (requirements.txt doesn't pin it; comfy's
    // base image torch is used as-is).
    pipPackages: [],
    gitRequirementsInstall: {
      repoUrl: 'https://github.com/ostris/ai-toolkit.git',
      cloneDir: AI_TOOLKIT_DIR,
    },
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
