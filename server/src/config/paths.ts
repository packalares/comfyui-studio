// Derived filesystem roots used by services.
//
// These wrap env overrides so call sites can import a named path instead of
// reconstructing `path.join(os.homedir(), '.config', ...)` in half a dozen
// places.
//
// Three roots, each with a clear purpose — do NOT cross streams:
//
//   1. BUNDLED_DATA_DIR (`server/data/`) — bundled READ-ONLY seeds shipped
//      with the image (e.g. `all_nodes.mirrored.json`, `model-list.json`).
//      Overwritten on image rebuilds. Services must never write here.
//
//   2. STUDIO_CONFIG_ROOT (`~/.config/comfyui-studio/`) — user config that
//      the operator may hand-edit (catalog, config, pip.conf, widgets).
//      Persists across image rebuilds.
//
//   3. runtimeStateDir (`~/.config/comfyui-studio/runtime/`) — runtime-
//      written JSON state (plugin cache, history, download history, env
//      config, network check logs, reset logs). Lives under the same
//      persistent root as user config but is visibly separated so ops can
//      tell machine-written state from human-edited state at a glance.

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { env, currentSqliteOverride } from './env.js';

const STUDIO_CONFIG_ROOT = path.join(os.homedir(), '.config', 'comfyui-studio');
const RUNTIME_STATE_DIR = path.join(STUDIO_CONFIG_ROOT, 'runtime');

// ACE-Step music feature: all mutable, user-generated data (generated song
// audio, uploaded reference/source audio, training datasets, downloaded
// lyrics-LLM GGUF weights) lives under this one runtime-state subdir. This is
// deliberately separate from `services/packs/registry.ts`'s
// `~/.local/share/comfy-packs/ace-step/` tree, which holds the PACK's own
// pip-installed deps + auto-downloaded DiT/whisper/IndexTTS2 checkpoints —
// that root is package-manager-owned install state, this one is user data.
const ACE_MUSIC_ROOT = path.join(RUNTIME_STATE_DIR, 'ace-music');

// Image-LoRA training (ostris/ai-toolkit) feature: user datasets, generated
// per-job YAML configs, and the trainer's own output tree. Deliberately
// separate from `services/packs/registry.ts`'s `AI_TOOLKIT_DIR`, which is the
// pip/git-managed SOURCE CHECKOUT (package-manager-owned install state) —
// same split `ACE_MUSIC_ROOT` documents above for the `ace-step` pack.
const AI_TOOLKIT_ROOT = path.join(RUNTIME_STATE_DIR, 'ai-toolkit');

// Resolve `server/data/` relative to this file so bundled JSONs can be
// located at runtime without relying on CWD. `config/paths.ts` lives at
// `server/src/config/paths.ts`; `../..` climbs to `server/`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = path.resolve(HERE, '..', '..', 'data');

export const paths = {
  configRoot: STUDIO_CONFIG_ROOT,
  /** Root for runtime-written state (persists across image rebuilds). */
  runtimeStateDir: RUNTIME_STATE_DIR,
  catalogFile: env.STUDIO_CATALOG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'catalog.json'),
  /**
   * Local cache of ltdrdata/ComfyUI-Manager `model-list.json`. Refreshed on
   * boot (best-effort) so catalog seeding tolerates upstream outages.
   */
  modelListCachePath: path.join(STUDIO_CONFIG_ROOT, 'model-list.cache.json'),
  configFile: env.STUDIO_CONFIG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'config.json'),
  exposedWidgetsDir: env.STUDIO_EXPOSED_WIDGETS_DIR
    ?? path.join(STUDIO_CONFIG_ROOT, 'exposed_widgets'),
  /** Absolute root of ComfyUI's model tree on disk. May be empty - stat-fallback disabled. */
  modelsDir: env.MODELS_DIR,
  /** ComfyUI's per-prompt output tree (gallery files land here). */
  comfyOutputDir: env.COMFYUI_PATH ? path.join(env.COMFYUI_PATH, 'output') : '',
  /** ComfyUI's input tree (uploaded source images for img2img / video init). */
  comfyInputDir: env.COMFYUI_PATH ? path.join(env.COMFYUI_PATH, 'input') : '',
  /**
   * Directory holding bundled READ-ONLY seeds (all_nodes.mirrored.json,
   * model-list.json). Do NOT write here — use the named runtime-state paths
   * below for mutable JSON.
   */
  dataDir: env.DATA_DIR || BUNDLED_DATA_DIR,
  /**
   * Bundled prompt-enhancer profile library + master template + genres /
   * operations / negative defaults / video presets. Always resolves to the
   * bundled `server/data/enhancer/` directory — NOT overridable via
   * $DATA_DIR — because these are read-only seeds shipped with the
   * deployment, not runtime-mutable state. Letting $DATA_DIR override here
   * would silently hide the bundled profiles on every pod that points
   * dataDir at a runtime cache dir.
   */
  enhancerDir: path.join(BUNDLED_DATA_DIR, 'enhancer'),
  /** Bundled plugin-catalog snapshot (tracked, read-only). */
  nodeListPath: env.NODE_LIST_PATH || path.join(BUNDLED_DATA_DIR, 'all_nodes.mirrored.json'),
  /** Mutable plugin cache written by the plugin service (runtime). */
  modelCachePath: env.MODEL_CACHE_PATH || path.join(RUNTIME_STATE_DIR, 'model-cache.json'),
  /** Mutable plugin history written by the plugin service (runtime). */
  pluginHistoryPath: env.PLUGIN_HISTORY_PATH
    || path.join(RUNTIME_STATE_DIR, 'plugin-history.json'),
  /** pip config file consumed by the python service. */
  pipConfigPath: path.join(STUDIO_CONFIG_ROOT, 'pip.conf'),
  /**
   * Launcher system-settings (HF endpoint / GitHub proxy / pip source) persistence.
   * DATA_DIR override preserved for back-compat with existing deployments.
   */
  envConfigFile: env.DATA_DIR
    ? path.join(env.DATA_DIR, 'env-config.json')
    : path.join(RUNTIME_STATE_DIR, 'env-config.json'),
  /**
   * Per-run network check log directory.
   * DATA_DIR override preserved for back-compat with existing deployments.
   */
  networkCheckDir: env.DATA_DIR
    ? path.join(env.DATA_DIR, 'network-checks')
    : path.join(RUNTIME_STATE_DIR, 'network-checks'),
  /** Directory for ComfyUI reset-operation log files. */
  resetLogsDir: path.join(RUNTIME_STATE_DIR, 'reset-logs'),
  /** Temp spool for in-flight multipart uploads (multer diskStorage writes
   *  here; files are deleted in the request handler's finally block).
   *  Sits under the runtime state dir so it shares the same persistent
   *  volume as the DB — avoids /tmp tmpfs limits on some k8s setups. */
  uploadsTmpDir: path.join(RUNTIME_STATE_DIR, 'uploads'),
  /** Mutable download history written by the downloadController (runtime). */
  downloadHistoryPath: path.join(RUNTIME_STATE_DIR, 'download-history.json'),
  /** Mutable ComfyUI launch-options config (runtime). */
  launchOptionsPath: path.join(RUNTIME_STATE_DIR, 'comfyui-launch-options.json'),
  /**
   * User-imported workflow templates. Each file is a TemplateData JSON blob
   * whose `workflow` key holds the LiteGraph document from civitai (or
   * another user source). Merged into the live template cache so the Studio
   * treats them identically to upstream ComfyUI templates.
   */
  userTemplatesDir: path.join(STUDIO_CONFIG_ROOT, 'user-workflows'),
  /**
   * User-editable prompt-token registry. JSON file mapping a short token
   * name (`@business`) to a list of options the PromptComposer chip widget
   * surfaces. Missing file → empty registry; `@foo` tokens with no registry
   * entry are silently stripped from the resolved prompt.
   */
  promptRegistryFile: path.join(STUDIO_CONFIG_ROOT, 'prompt-registry.json'),
  /**
   * User-writable personality directory. Houses user-authored soul files
   * (souls/*.md) and memory.md. These overlay the bundled seeds in
   * `bundledPersonalitiesDir`; user files always win on name collision.
   * Persists across image rebuilds alongside other user config.
   */
  personalitiesDir: path.join(STUDIO_CONFIG_ROOT, 'personalities'),
  /**
   * Pending soul edit proposals from the studio_propose_soul_edit MCP tool.
   * Each file is a <id>.json blob the user reviews and accepts/rejects via
   * the personality API. Never applied without explicit user confirmation.
   */
  pendingSoulEditsDir: path.join(STUDIO_CONFIG_ROOT, 'personalities', 'pending-soul-edits'),
  /**
   * Timestamped soul file backups created before applying a pending edit.
   * Allows rollback if the user decides the applied change was wrong.
   */
  soulBackupsDir: path.join(STUDIO_CONFIG_ROOT, 'personalities', 'soul-backups'),
  /**
   * Bundled read-only personality seeds shipped with the image. Contains
   * default.md and security-auditor.md souls, and an empty memory.md stub.
   * Services must never write here; use `personalitiesDir` for mutations.
   */
  bundledPersonalitiesDir: path.join(BUNDLED_DATA_DIR, 'personalities'),
  /**
   * Bundled read-only skill seeds. Each skill is a folder containing SKILL.md
   * and optional scripts/. Services must never write here.
   */
  bundledSkillsDir: path.join(BUNDLED_DATA_DIR, 'skills'),
  /**
   * Bundled read-only command seeds. Each command is a single <name>.md file.
   * Services must never write here.
   */
  bundledCommandsDir: path.join(BUNDLED_DATA_DIR, 'commands'),
  /**
   * Bundled read-only LLM prompt + chat-suggestion defaults. Single file.
   * User overlay path resolves through `currentConfigRootOverride` so tests
   * can swap it via STUDIO_CONFIG_ROOT — see promptsLoader for the lookup.
   */
  bundledPromptsFile: path.join(BUNDLED_DATA_DIR, 'chat', 'default_prompts.md'),
  /**
   * Single sqlite database file backing the gallery + plugin catalog queries.
   * Overridable via `STUDIO_SQLITE_PATH` so tests can point it at a tmpdir
   * and swap the file on every test case. Resolved lazily via the getter
   * below so per-test env mutations take effect without re-importing.
   */
  get sqlitePath(): string {
    const override = currentSqliteOverride();
    return (override && override.length > 0)
      ? override
      : path.join(RUNTIME_STATE_DIR, 'studio.db');
  },
  /**
   * Generated song audio output (flac/mp3/wav files ACE-Step produces,
   * downloaded and persisted by `services/ace/storage.ts`). Served back to
   * the UI via a route-level path, never exposed as a static mount.
   */
  aceAudioDir: path.join(ACE_MUSIC_ROOT, 'audio'),
  /**
   * Uploaded reference/source audio (cover mode, audio2audio, extract-codes)
   * — user-supplied input files, distinct from `aceAudioDir`'s generated
   * output.
   */
  aceReferencesDir: path.join(ACE_MUSIC_ROOT, 'references'),
  /** Training datasets for the LoRA fine-tuning pipeline. */
  aceDatasetsDir: path.join(ACE_MUSIC_ROOT, 'datasets'),
  /**
   * audio-separator's own auto-downloaded model cache (`--model_file_dir`).
   * Unlike the `ace-step` pack's fixed model list (registry.ts — DiT
   * checkpoints, Whisper, IndexTTS2, all pinned HF repo ids resolved at
   * install time), audio-separator pulls whichever stem-separation model the
   * caller names from its own upstream registry the first time it's used —
   * so this is user-mutable runtime cache state, not a pack-declared install,
   * same reasoning as `aceLyricsModelsDir`.
   */
  aceStemSeparatorModelDir: path.join(ACE_MUSIC_ROOT, 'stem-separator-models'),
  /**
   * Downloaded lyrics-LLM GGUF weights (user-selected from a small catalog,
   * not part of the `ace-step` pack's auto-installed model list).
   */
  aceLyricsModelsDir: path.join(ACE_MUSIC_ROOT, 'lyrics-models'),
  /**
   * Bundled read-only lyrics-generation script (llama-cpp-python, CPU-only
   * inference — see `routes/ace/lyrics.routes.ts` for why it never touches
   * the GPU scheduler). Ships with the image; never written to.
   */
  aceLyricsScript: path.join(BUNDLED_DATA_DIR, 'ace', 'lyrics_generate.py'),
  /**
   * Raw per-dataset audio uploads for the LoRA training pipeline, prior to
   * `build-dataset` scanning them into a dataset JSON. Mirrors ace-step-ui's
   * `config.datasets.uploadsDir` (there: `<ACE-Step checkout>/datasets/uploads`).
   * comfy has no ACE-Step source checkout to nest under — `ace-step` is a
   * plain pip package here — so this lives under comfy's own ACE_MUSIC_ROOT.
   */
  aceDatasetUploadsDir: path.join(ACE_MUSIC_ROOT, 'dataset-uploads'),
  /**
   * Root for trained LoRA adapter output directories
   * (`<this>/<runId>/final/adapter/adapter_config.json` once a run
   * completes). Passed as `lora_output_dir` to ACE-Step's
   * `/v1/training/start`; also the default root `routes/ace/training.routes.ts`
   * walks for `GET /lora-checkpoints`.
   */
  aceLoraOutputDir: path.join(ACE_MUSIC_ROOT, 'lora-output'),
  /**
   * Voice-clone TTS (IndexTTS2) output WAVs, served the same way generated
   * song audio is (see `services/ace/storage.ts`'s `output` kind) but kept
   * in its own subdir since TTS clips aren't songs.
   */
  aceTtsOutputDir: path.join(ACE_MUSIC_ROOT, 'tts'),
  /**
   * Bundled read-only Whisper batch-transcription script (faster-whisper).
   * Writes `<basename>.txt` + `<basename>.lang.txt` companions next to each
   * input file — picked up by `build-dataset`. Ships with the image.
   */
  aceWhisperScript: path.join(BUNDLED_DATA_DIR, 'ace', 'whisper_cli.py'),
  /**
   * Bundled read-only IndexTTS2 voice-clone inference script. Invoked as a
   * subprocess by `services/ace/indextts2.ts`. Ships with the image.
   */
  aceIndexTts2Script: path.join(BUNDLED_DATA_DIR, 'ace', 'indextts2_infer.py'),
  /**
   * Bundled read-only GPU-tier probe script (`acestep.gpu_config`) — reports
   * max generation duration/batch size for the current card. Ships with the
   * image.
   */
  aceGetLimitsScript: path.join(BUNDLED_DATA_DIR, 'ace', 'get_limits.py'),
  /**
   * Root for image-LoRA training datasets: one subdirectory per dataset,
   * each holding the uploaded images + sibling `<basename>.txt` caption
   * files (ai-toolkit's own convention — see `services/aiToolkit/config.ts`).
   */
  aiToolkitDatasetsDir: path.join(AI_TOOLKIT_ROOT, 'datasets'),
  /**
   * Generated per-job ai-toolkit YAML configs (`services/aiToolkit/config.ts`
   * writes one file here per training run before spawning `run.py`). Kept
   * around after the run for debugging, not cleaned up automatically.
   */
  aiToolkitConfigsDir: path.join(AI_TOOLKIT_ROOT, 'configs'),
  /**
   * ai-toolkit's `training_folder` — the root every job's `save_root`
   * (`<this>/<jobName>/<jobName>.safetensors`) is written under. The
   * finished LoRA is copied from here into ComfyUI's `models/loras/` once a
   * run succeeds (see `services/aiToolkit/lorasDir.ts`); this tree is kept
   * as the durable "raw trainer output" record.
   */
  aiToolkitOutputDir: path.join(AI_TOOLKIT_ROOT, 'output'),
} as const;

export type Paths = typeof paths;
