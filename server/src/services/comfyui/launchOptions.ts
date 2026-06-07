// ComfyUI launch-options: JSON I/O, CLI args builder, and default items.
// Keys, ordering, and types define the CLI_ARGS contract with the ComfyUI
// entrypoint script — do not reorder without updating the runner.

import fs from 'fs';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import {
  readRequiredFrontendVersion,
  readValidComfyFlags,
} from './comfyIntrospect.js';

// ---- Types ----

export type LaunchOptionType = 'flag' | 'string' | 'number' | 'enum';

export interface LaunchOptionItem {
  key: string;
  value?: string | number | boolean | null;
  enabled: boolean;
  type: LaunchOptionType;
  description: string;
  category?: string;
  order?: number;
  /** User cannot edit value (e.g. port, front-end-version). */
  readOnly?: boolean;
}

export interface LaunchOptionsConfig {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs?: string;
}

export interface LaunchCommandView {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs: string;
  baseCommand: string;
  fixedArgs: string[];
  extraArgs: string[];
  fullCommandLine: string;
}

// ---- Defaults ----

/** Default frontend version pinned as a last-resort constant. */
const HARDCODED_FRONTEND_VERSION = 'Comfy-Org/ComfyUI_frontend@v1.42.2';

/**
 * Resolve the effective frontend version with a three-tier fallback:
 *  1. `readRequiredFrontendVersion()` — parsed from installed ComfyUI's requirements.txt
 *  2. `env.CLI_ARGS` parse — if the operator already pinned it via CLI_ARGS env
 *  3. Hardcoded constant — last resort
 */
export function getDefaultFrontendVersion(): string {
  const fromInstall = readRequiredFrontendVersion();
  if (fromInstall) return fromInstall;
  const cliArgs = env.CLI_ARGS || '';
  const m = cliArgs.match(/--front-end-version\s+(\S+)/);
  return m ? m[1] : HARDCODED_FRONTEND_VERSION;
}

/** Runtime fallback for CLI_ARGS when env is empty. Uses the derived frontend version. */
export function buildDefaultCliArgsFallback(): string {
  const version = getDefaultFrontendVersion();
  return `--disable-xformers --disable-smart-memory --disable-cuda-malloc --front-end-version ${version}`;
}

/**
 * Static deny-list of flags removed from ComfyUI upstream.
 * Used as fallback when `readValidComfyFlags()` returns null.
 * Updating this set silently drops the flag from launch commands.
 */
const REMOVED_FLAGS = new Set(['--normalvram']);

/** Strip removed flags from a CLI_ARGS-style string, preserving spacing. */
export function stripRemovedFlags(cliArgs: string): string {
  return cliArgs
    .split(/\s+/)
    .filter((tok) => !REMOVED_FLAGS.has(tok))
    .join(' ')
    .trim();
}

/**
 * Check whether a given CLI flag key is valid for the installed ComfyUI.
 *
 * When `readValidComfyFlags()` returned a live set, that set is the truth.
 * When introspection failed (returns null), fall back to the static deny-list:
 *   a flag is considered valid unless it appears in REMOVED_FLAGS.
 */
export function isValidComfyFlag(key: string): boolean {
  const liveFlags = readValidComfyFlags();
  if (liveFlags !== null) {
    return liveFlags.some((f) => f.optionString === key);
  }
  // Fallback: allow everything not in the static deny-list
  return !REMOVED_FLAGS.has(key);
}

/**
 * Filter a CLI_ARGS-style array, removing flags that are no longer valid.
 * Logs once per launch for any dropped keys.
 * Replaces the former `stripRemovedFlags` function for launch-command building.
 */
export function filterInvalidFlags(tokens: string[]): string[] {
  const dropped: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      if (!isValidComfyFlag(tok)) {
        dropped.push(tok);
        i++;
        // Skip the associated value token if it follows
        if (i < tokens.length && !tokens[i].startsWith('-')) i++;
        continue;
      }
    }
    out.push(tok);
    i++;
  }
  if (dropped.length > 0) {
    logger.warn('[launchOptions] dropping invalid/removed flags', { flags: dropped });
  }
  return out;
}

/** Args --listen and --port are fixed in the entrypoint; never emit via CLI. */
export const FIXED_IN_ENTRYPOINT = new Set(['--listen', '--port']);

// ---- Curated metadata items ----

export function buildDefaultItems(): LaunchOptionItem[] {
  return [
    ...networkItems(),
    ...pathItems(),
    ...startupItems(),
    ...deviceItems(),
    ...precisionItems(),
    ...previewItems(),
    ...cacheItems(),
    ...attentionItems(),
    ...managerItems(),
    ...vramItems(),
    ...debugItems(),
    ...frontendItems(),
    ...discoveredItems(),
  ];
}

function networkItems(): LaunchOptionItem[] {
  const port = env.COMFYUI_PORT;
  const frontendVersion = getDefaultFrontendVersion();
  return [
    { key: '--port', value: port, enabled: true, type: 'number', description: 'Service listen port (fixed by system)', category: 'network', order: 1, readOnly: true },
    { key: '--front-end-version', value: frontendVersion, enabled: true, type: 'string', description: 'Frontend version (fixed by system)', category: 'network', order: 2, readOnly: true },
    { key: '--tls-keyfile', value: null, enabled: false, type: 'string', description: 'TLS/SSL key file path (enables HTTPS)', category: 'network', order: 3 },
    { key: '--tls-certfile', value: null, enabled: false, type: 'string', description: 'TLS/SSL cert file path (pair with --tls-keyfile)', category: 'network', order: 4 },
    { key: '--enable-cors-header', value: null, enabled: false, type: 'string', description: 'Enable CORS; optional origin or * for all', category: 'network', order: 5 },
    { key: '--max-upload-size', value: 100, enabled: false, type: 'number', description: 'Max upload size (MB)', category: 'network', order: 6 },
  ];
}

function pathItems(): LaunchOptionItem[] {
  return [
    { key: '--base-directory', value: null, enabled: false, type: 'string', description: 'ComfyUI base directory (models, custom_nodes, ...)', category: 'paths', order: 10 },
    { key: '--extra-model-paths-config', value: null, enabled: false, type: 'string', description: 'Path to extra_model_paths.yaml (repeatable)', category: 'paths', order: 11 },
    { key: '--output-directory', value: null, enabled: false, type: 'string', description: 'Output directory (overrides --base-directory)', category: 'paths', order: 12 },
    { key: '--temp-directory', value: null, enabled: false, type: 'string', description: 'Temporary directory', category: 'paths', order: 13 },
    { key: '--input-directory', value: null, enabled: false, type: 'string', description: 'Input directory', category: 'paths', order: 14 },
    { key: '--user-directory', value: null, enabled: false, type: 'string', description: 'User directory (absolute path)', category: 'paths', order: 15 },
  ];
}

function startupItems(): LaunchOptionItem[] {
  return [
    { key: '--auto-launch', enabled: false, type: 'flag', description: 'Open default browser on startup', category: 'startup', order: 20 },
    { key: '--disable-auto-launch', enabled: false, type: 'flag', description: 'Disable auto-open browser', category: 'startup', order: 21 },
  ];
}

function deviceItems(): LaunchOptionItem[] {
  return [
    { key: '--cuda-device', value: null, enabled: false, type: 'number', description: 'Use this CUDA device; hide others', category: 'device', order: 30 },
    { key: '--default-device', value: null, enabled: false, type: 'number', description: 'Default device; other devices still visible', category: 'device', order: 31 },
    { key: '--cuda-malloc', enabled: false, type: 'flag', description: 'Enable cudaMallocAsync (torch 2.0+ default)', category: 'device', order: 32 },
    { key: '--disable-cuda-malloc', enabled: false, type: 'flag', description: 'Disable cudaMallocAsync', category: 'device', order: 33 },
    { key: '--directml', value: null, enabled: false, type: 'number', description: 'Use torch-directml (optional device)', category: 'device', order: 34 },
    { key: '--oneapi-device-selector', value: null, enabled: false, type: 'string', description: 'oneAPI device selector', category: 'device', order: 35 },
    { key: '--disable-ipex-optimize', enabled: false, type: 'flag', description: 'Disable Intel IPEX model-load optimizations', category: 'device', order: 36 },
    { key: '--supports-fp8-compute', enabled: false, type: 'flag', description: 'Assume device supports fp8 compute', category: 'device', order: 37 },
  ];
}

function precisionItems(): LaunchOptionItem[] {
  return [
    { key: '--force-fp32', enabled: false, type: 'flag', description: 'Force FP32', category: 'precision', order: 40 },
    { key: '--force-fp16', enabled: false, type: 'flag', description: 'Force FP16', category: 'precision', order: 41 },
    { key: '--fp32-unet', enabled: false, type: 'flag', description: 'Diffusion model in FP32', category: 'precision', order: 42 },
    { key: '--fp64-unet', enabled: false, type: 'flag', description: 'Diffusion model in FP64', category: 'precision', order: 43 },
    { key: '--bf16-unet', enabled: false, type: 'flag', description: 'Diffusion model in BF16', category: 'precision', order: 44 },
    { key: '--fp16-unet', enabled: false, type: 'flag', description: 'Diffusion model in FP16', category: 'precision', order: 45 },
    { key: '--fp8_e4m3fn-unet', enabled: false, type: 'flag', description: 'UNET weights stored as fp8_e4m3fn', category: 'precision', order: 46 },
    { key: '--fp8_e5m2-unet', enabled: false, type: 'flag', description: 'UNET weights stored as fp8_e5m2', category: 'precision', order: 47 },
    { key: '--fp8_e8m0fnu-unet', enabled: false, type: 'flag', description: 'UNET weights stored as fp8_e8m0fnu', category: 'precision', order: 48 },
    { key: '--fp16-vae', enabled: false, type: 'flag', description: 'VAE in FP16 (may cause black images)', category: 'precision', order: 49 },
    { key: '--fp32-vae', enabled: false, type: 'flag', description: 'VAE in FP32', category: 'precision', order: 50 },
    { key: '--bf16-vae', enabled: false, type: 'flag', description: 'VAE in BF16', category: 'precision', order: 51 },
    { key: '--cpu-vae', enabled: false, type: 'flag', description: 'VAE on CPU', category: 'precision', order: 52 },
    { key: '--fp8_e4m3fn-text-enc', enabled: false, type: 'flag', description: 'Text encoder weights fp8 (e4m3fn)', category: 'precision', order: 53 },
    { key: '--fp8_e5m2-text-enc', enabled: false, type: 'flag', description: 'Text encoder weights fp8 (e5m2)', category: 'precision', order: 54 },
    { key: '--fp16-text-enc', enabled: false, type: 'flag', description: 'Text encoder weights FP16', category: 'precision', order: 55 },
    { key: '--fp32-text-enc', enabled: false, type: 'flag', description: 'Text encoder weights FP32', category: 'precision', order: 56 },
    { key: '--bf16-text-enc', enabled: false, type: 'flag', description: 'Text encoder weights BF16', category: 'precision', order: 57 },
    { key: '--force-channels-last', enabled: false, type: 'flag', description: 'Force channels-last layout at inference', category: 'precision', order: 58 },
  ];
}

function previewItems(): LaunchOptionItem[] {
  return [
    { key: '--preview-method', value: 'none', enabled: false, type: 'string', description: 'Sampler preview method: none, auto, latent2rgb, taesd', category: 'preview', order: 60 },
    { key: '--preview-size', value: 512, enabled: false, type: 'number', description: 'Max preview size at sampler', category: 'preview', order: 61 },
  ];
}

function cacheItems(): LaunchOptionItem[] {
  return [
    { key: '--cache-classic', enabled: false, type: 'flag', description: 'Use legacy (aggressive) cache', category: 'cache', order: 70 },
    { key: '--cache-lru', value: null, enabled: false, type: 'number', description: 'LRU cache, keep last N node results', category: 'cache', order: 71 },
    { key: '--cache-none', enabled: false, type: 'flag', description: 'Never cache; saves RAM, re-runs all nodes', category: 'cache', order: 72 },
    { key: '--cache-ram', value: null, enabled: false, type: 'number', description: 'Cache under RAM pressure; threshold (GB)', category: 'cache', order: 73 },
  ];
}

function attentionItems(): LaunchOptionItem[] {
  return [
    { key: '--use-split-cross-attention', enabled: false, type: 'flag', description: 'Use split cross attention', category: 'attention', order: 80 },
    { key: '--use-quad-cross-attention', enabled: false, type: 'flag', description: 'Use sub-quadratic cross attention', category: 'attention', order: 81 },
    { key: '--use-pytorch-cross-attention', enabled: false, type: 'flag', description: 'Use PyTorch 2.0 cross attention', category: 'attention', order: 82 },
    { key: '--use-sage-attention', enabled: false, type: 'flag', description: 'Use sage attention', category: 'attention', order: 83 },
    { key: '--use-flash-attention', enabled: false, type: 'flag', description: 'Use FlashAttention', category: 'attention', order: 84 },
    { key: '--disable-xformers', enabled: false, type: 'flag', description: 'Disable xformers', category: 'attention', order: 85 },
    { key: '--force-upcast-attention', enabled: false, type: 'flag', description: 'Force attention upcast (may fix black images)', category: 'attention', order: 86 },
    { key: '--dont-upcast-attention', enabled: false, type: 'flag', description: 'Disable all attention upcasting', category: 'attention', order: 87 },
  ];
}

function managerItems(): LaunchOptionItem[] {
  return [
    { key: '--enable-manager', enabled: false, type: 'flag', description: 'Enable ComfyUI-Manager', category: 'manager', order: 90 },
    { key: '--disable-manager-ui', enabled: false, type: 'flag', description: 'Disable Manager UI only; background tasks still run', category: 'manager', order: 91 },
    { key: '--enable-manager-legacy-ui', enabled: false, type: 'flag', description: 'Enable ComfyUI-Manager legacy UI', category: 'manager', order: 92 },
  ];
}

function vramItems(): LaunchOptionItem[] {
  return [
    { key: '--gpu-only', enabled: false, type: 'flag', description: 'Store and run everything on GPU (incl. CLIP)', category: 'vram', order: 100 },
    { key: '--highvram', enabled: false, type: 'flag', description: 'Keep models in GPU memory after use', category: 'vram', order: 101 },
    { key: '--lowvram', enabled: false, type: 'flag', description: 'Split UNET to lower VRAM usage', category: 'vram', order: 103 },
    { key: '--novram', enabled: false, type: 'flag', description: 'Use when lowvram still insufficient', category: 'vram', order: 104 },
    { key: '--cpu', enabled: false, type: 'flag', description: 'Run everything on CPU (slower)', category: 'vram', order: 105 },
    { key: '--reserve-vram', value: null, enabled: false, type: 'number', description: 'Reserve VRAM (GB) for system/other apps', category: 'vram', order: 106 },
    { key: '--async-offload', value: null, enabled: false, type: 'number', description: 'Async weight offload; stream count (default 2)', category: 'vram', order: 107 },
    { key: '--disable-async-offload', enabled: false, type: 'flag', description: 'Disable async weight offload', category: 'vram', order: 108 },
    { key: '--disable-dynamic-vram', enabled: false, type: 'flag', description: 'Disable dynamic VRAM; use estimated-load', category: 'vram', order: 109 },
    { key: '--force-non-blocking', enabled: false, type: 'flag', description: 'Force non-blocking tensor ops', category: 'vram', order: 110 },
    { key: '--default-hashing-function', value: 'sha256', enabled: false, type: 'string', description: 'Duplicate/content hash: md5, sha1, sha256, sha512', category: 'vram', order: 111 },
    { key: '--disable-smart-memory', enabled: false, type: 'flag', description: 'Force aggressive offload to RAM over VRAM', category: 'vram', order: 112 },
    { key: '--deterministic', enabled: false, type: 'flag', description: 'PyTorch deterministic algorithms (slower)', category: 'vram', order: 113 },
    { key: '--fast', enabled: false, type: 'flag', description: 'Enable experimental optimizations', category: 'perf', order: 114 },
    { key: '--disable-pinned-memory', enabled: false, type: 'flag', description: 'Disable pinned memory', category: 'vram', order: 115 },
    { key: '--mmap-torch-files', enabled: false, type: 'flag', description: 'mmap when loading ckpt/pt', category: 'vram', order: 116 },
    { key: '--disable-mmap', enabled: false, type: 'flag', description: 'Disable mmap for safetensors', category: 'vram', order: 117 },
  ];
}

function debugItems(): LaunchOptionItem[] {
  return [
    { key: '--dont-print-server', enabled: false, type: 'flag', description: 'Silence server stdout', category: 'debug', order: 120 },
    { key: '--quick-test-for-ci', enabled: false, type: 'flag', description: 'CI quick test', category: 'debug', order: 121 },
    { key: '--windows-standalone-build', enabled: false, type: 'flag', description: 'Windows standalone convenience', category: 'debug', order: 122 },
    { key: '--disable-metadata', enabled: false, type: 'flag', description: 'Do not save prompt metadata in files', category: 'debug', order: 123 },
    { key: '--disable-all-custom-nodes', enabled: false, type: 'flag', description: 'Disable loading all custom nodes', category: 'debug', order: 124 },
    { key: '--whitelist-custom-nodes', value: null, enabled: false, type: 'string', description: 'Directories to still load when all disabled (space-separated)', category: 'debug', order: 125 },
    { key: '--disable-api-nodes', enabled: false, type: 'flag', description: 'Disable all API nodes + frontend network', category: 'debug', order: 126 },
    { key: '--multi-user', enabled: false, type: 'flag', description: 'Enable per-user storage', category: 'debug', order: 127 },
    { key: '--verbose', value: 'INFO', enabled: false, type: 'string', description: 'Log level: DEBUG, INFO, WARNING, ERROR, CRITICAL', category: 'debug', order: 128 },
    { key: '--log-stdout', enabled: false, type: 'flag', description: 'Output to stdout instead of stderr', category: 'debug', order: 129 },
  ];
}

function frontendItems(): LaunchOptionItem[] {
  return [
    { key: '--front-end-root', value: null, enabled: false, type: 'string', description: 'Local frontend dir path (overrides --front-end-version)', category: 'frontend', order: 130 },
    { key: '--enable-compress-response-body', enabled: false, type: 'flag', description: 'Enable response body compression', category: 'frontend', order: 131 },
    { key: '--comfy-api-base', value: 'https://api.comfy.org', enabled: false, type: 'string', description: 'ComfyUI API base URL', category: 'frontend', order: 132 },
    { key: '--database-url', value: null, enabled: false, type: 'string', description: 'Database URL (e.g. sqlite:///:memory:)', category: 'frontend', order: 133 },
    { key: '--enable-assets', enabled: false, type: 'flag', description: 'Enable assets system (API, DB sync, scan)', category: 'frontend', order: 134 },
  ];
}

/**
 * Build items for flags discovered in the installed ComfyUI that are NOT
 * present in the curated metadata above. These appear at the bottom of the
 * UI with category `'discovered'` and are disabled by default.
 */
function discoveredItems(): LaunchOptionItem[] {
  const liveFlags = readValidComfyFlags();
  if (!liveFlags) return [];

  // Build a set of all curated keys so we can find the gaps
  const curated = new Set<string>([
    ...networkItems(),
    ...pathItems(),
    ...startupItems(),
    ...deviceItems(),
    ...precisionItems(),
    ...previewItems(),
    ...cacheItems(),
    ...attentionItems(),
    ...managerItems(),
    ...vramItems(),
    ...debugItems(),
    ...frontendItems(),
  ].map((i) => i.key));

  const newFlags = liveFlags.filter((f) => !curated.has(f.optionString));

  if (newFlags.length > 0) {
    logger.info(
      `[launchOptions] discovered ${newFlags.length} new ComfyUI flags not in curated metadata`,
      { flags: newFlags.map((f) => f.optionString) },
    );
  }

  return newFlags.map((f, idx): LaunchOptionItem => ({
    key: f.optionString,
    value: f.defaultValue !== undefined ? f.defaultValue : null,
    enabled: false,
    type: f.type,
    description: f.help ?? '',
    category: 'discovered',
    order: 1000 + idx,
    readOnly: false,
  }));
}

// ---- CLI builder ----

interface LaunchOptionsConfigLike {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs?: string;
}

// Strip --port and --front-end-version from manual args (system-fixed).
function filterReadonlyFromManual(tokens: string[]): string[] {
  const strip = new Set(['--port', '--front-end-version']);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (strip.has(tokens[i])) {
      i++;
      if (i < tokens.length && !tokens[i].startsWith('-')) i++;
      continue;
    }
    out.push(tokens[i]);
    i++;
  }
  return out;
}

export function buildExtraArgsArray(cfg: LaunchOptionsConfigLike): string[] {
  if (cfg.mode === 'manual') {
    const manual = (cfg.manualArgs || '').trim();
    if (!manual) return [];
    return filterReadonlyFromManual(manual.split(/\s+/).filter(Boolean));
  }
  const args: string[] = [];
  for (const item of cfg.items) {
    if (!item.enabled || !item.key) continue;
    if (FIXED_IN_ENTRYPOINT.has(item.key)) continue;
    if (!/^[-a-zA-Z0-9_]+$/.test(item.key)) continue;
    if (item.type === 'flag') { args.push(item.key); continue; }
    const value = item.value === undefined || item.value === null || item.value === ''
      ? null : String(item.value);
    if (item.key === '--front-end-version') {
      args.push(item.key, value || getDefaultFrontendVersion());
      continue;
    }
    if (value !== null) args.push(item.key, value);
  }
  return args;
}

export function buildLaunchCommandView(cfg: LaunchOptionsConfigLike): LaunchCommandView {
  const extraArgs = buildExtraArgsArray(cfg);
  const baseCommand = 'python3 ./ComfyUI/main.py';
  const fixedArgs = ['--listen', '--port', String(env.COMFYUI_PORT)];
  const fullParts = [baseCommand, ...fixedArgs, ...extraArgs].filter(Boolean);
  return {
    mode: cfg.mode,
    items: cfg.items,
    manualArgs: cfg.manualArgs || '',
    baseCommand,
    fixedArgs,
    extraArgs,
    fullCommandLine: fullParts.join(' ').trim(),
  };
}

// ---- JSON I/O ----

function configFilePath(): string {
  return paths.launchOptionsPath;
}

// Apply a CLI args string onto a base items list. Tokens starting with '-'
// introduce a key; the next token is its value unless it also starts with '-'.
function applyCliArgsToItems(cliArgs: string, baseItems: LaunchOptionItem[]): LaunchOptionItem[] {
  const tokens = cliArgs.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return baseItems;
  const byKey = new Map(baseItems.map((i) => [i.key, { ...i }]));
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) { i++; continue; }
    const key = token;
    let value: string | null = null;
    const next = tokens[i + 1];
    if (next && !next.startsWith('-')) { value = next; i += 2; }
    else { i += 1; }
    const item = byKey.get(key);
    if (item) {
      item.enabled = true;
      if (item.type !== 'flag' && value !== null) item.value = value;
    } else {
      byKey.set(key, {
        key, value, enabled: true,
        type: value === null ? 'flag' : 'string',
        description: '', category: 'other', order: 9999,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getDefaultConfig(): LaunchOptionsConfig {
  const rawCliArgs = (env.CLI_ARGS || buildDefaultCliArgsFallback()).trim();
  const envCliArgs = stripRemovedFlags(rawCliArgs);
  const baseItems = buildDefaultItems();
  const seededItems = envCliArgs ? applyCliArgsToItems(envCliArgs, baseItems) : baseItems;
  return {
    mode: envCliArgs ? 'manual' : 'list',
    items: seededItems,
    manualArgs: envCliArgs,
  };
}

function ensureConfigFile(): void {
  const p = configFilePath();
  try {
    if (!fs.existsSync(p)) {
      atomicWrite(p, JSON.stringify(getDefaultConfig(), null, 2));
    }
  } catch (error) {
    logger.error('launch_options init failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeItem(
  item: LaunchOptionItem,
  def: LaunchOptionItem | undefined,
  index: number,
): LaunchOptionItem {
  const readOnly = def?.readOnly ?? item.readOnly ?? false;
  let value = item.value ?? def?.value ?? null;
  // System-managed keys always use the derived value — JSON is ignored for these.
  if (readOnly && item.key === '--port') value = env.COMFYUI_PORT;
  if (readOnly && item.key === '--front-end-version') value = getDefaultFrontendVersion();
  return {
    key: item.key,
    value,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : (def?.enabled ?? false),
    type: (item.type || def?.type || 'string') as LaunchOptionItem['type'],
    description: item.description || def?.description || '',
    category: item.category ?? def?.category,
    order: typeof item.order === 'number' ? item.order : index * 10,
    readOnly,
  };
}

function mergeWithDefaults(rawItems: LaunchOptionItem[]): LaunchOptionItem[] {
  const defaultConfig = getDefaultConfig();
  const defaultByKey = new Map(defaultConfig.items.map((i) => [i.key, i]));
  const rawKeys = new Set(rawItems.map((i) => i.key));
  const merged: LaunchOptionItem[] = rawItems
    .map((item, index) => normalizeItem(item, defaultByKey.get(item.key), index))
    .filter((item) => !!item.key);
  for (const def of defaultConfig.items) {
    if (rawKeys.has(def.key)) continue;
    let value = def.value ?? null;
    if (def.readOnly && def.key === '--port') value = env.COMFYUI_PORT;
    if (def.readOnly && def.key === '--front-end-version') value = getDefaultFrontendVersion();
    merged.push({
      key: def.key, value, enabled: def.enabled, type: def.type,
      description: def.description || '', category: def.category,
      order: def.order ?? 999, readOnly: def.readOnly,
    });
  }
  return merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Write back system-managed values to the JSON file if they differ from what
 * is stored. This keeps the file readable for ops people inspecting it.
 * Only system-managed (readOnly) keys are touched; user-editable fields are
 * left as-is.
 */
function maybeWriteBackSystemValues(
  cfg: LaunchOptionsConfig,
  rawItems: LaunchOptionItem[],
  filePath: string,
): void {
  const derivedFrontend = getDefaultFrontendVersion();
  const derivedPort: string | number = env.COMFYUI_PORT;

  // normalizeItem already coerced cfg.items[*].value to the derived value for
  // readOnly system-managed keys, so comparing those would always look equal.
  // Compare against the ORIGINAL on-disk values via rawItems to detect drift.
  const rawByKey = new Map(rawItems.map((i) => [i.key, i]));
  let dirty = false;
  for (const key of ['--front-end-version', '--port'] as const) {
    const raw = rawByKey.get(key);
    if (!raw) continue;
    const derived = key === '--front-end-version' ? derivedFrontend : derivedPort;
    if (raw.value !== derived) { dirty = true; break; }
  }
  if (!dirty) return;

  try {
    atomicWrite(filePath, JSON.stringify(cfg, null, 2));
  } catch (err) {
    logger.warn('[launchOptions] failed to write back system-managed values', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function readConfig(): LaunchOptionsConfig {
  ensureConfigFile();
  const defaultConfig = getDefaultConfig();
  try {
    const content = fs.readFileSync(configFilePath(), 'utf-8');
    const raw = JSON.parse(content) as Partial<LaunchOptionsConfig>;
    const mode = raw.mode === 'manual' ? 'manual' : 'list';
    const rawItems = Array.isArray(raw.items) ? raw.items : defaultConfig.items;
    const manualArgs = typeof raw.manualArgs === 'string'
      ? raw.manualArgs
      : defaultConfig.manualArgs || '';
    const result: LaunchOptionsConfig = { mode, items: mergeWithDefaults(rawItems), manualArgs };
    maybeWriteBackSystemValues(result, rawItems, configFilePath());
    return result;
  } catch (error) {
    logger.error('launch_options read failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return defaultConfig;
  }
}

function writeConfig(value: LaunchOptionsConfig): void {
  try {
    atomicWrite(configFilePath(), JSON.stringify(value, null, 2));
  } catch (error) {
    logger.error('launch_options write failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resetToDefault(): LaunchOptionsConfig {
  writeConfig(getDefaultConfig());
  return readConfig();
}

export function updateLaunchOptions(payload: Partial<LaunchOptionsConfig>): LaunchOptionsConfig {
  const current = readConfig();
  const mode = payload.mode === 'manual' ? 'manual' : 'list';
  const defaultByKey = new Map(getDefaultConfig().items.map((i) => [i.key, i]));
  const items = Array.isArray(payload.items)
    ? payload.items
      .map((item, index) => normalizeItem(item, defaultByKey.get(item.key), index))
      .filter((item) => !!item.key)
    : current.items;
  const manualArgs = typeof payload.manualArgs === 'string'
    ? payload.manualArgs : (current.manualArgs || '');
  const merged: LaunchOptionsConfig = { mode, items, manualArgs };
  writeConfig(merged);
  return merged;
}

export function buildCliArgs(): string[] {
  const rawArgs = buildExtraArgsArray(readConfig());
  return filterInvalidFlags(rawArgs);
}

export function buildCliArgsString(): string {
  return buildCliArgs().join(' ');
}

export function getLaunchOptions(): LaunchOptionsConfig {
  return readConfig();
}

export function getLaunchCommandView(): LaunchCommandView {
  return buildLaunchCommandView(readConfig());
}
