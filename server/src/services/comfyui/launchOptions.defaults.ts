// Default launch-option items. Keys, ordering, and types define the CLI_ARGS
// contract with the ComfyUI entrypoint script — do not reorder without
// updating the runner. Comments are English only.

import { env } from '../../config/env.js';

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

/** Default frontend version. Parse from env CLI_ARGS or use pinned constant. */
export function getDefaultFrontendVersion(): string {
  const cliArgs = env.CLI_ARGS || '';
  const m = cliArgs.match(/--front-end-version\s+(\S+)/);
  return m ? m[1] : 'Comfy-Org/ComfyUI_frontend@v1.42.2';
}

/** Runtime fallback for CLI_ARGS when env is empty. */
export const DEFAULT_CLI_ARGS_FALLBACK =
  '--normalvram --disable-xformers --disable-smart-memory --disable-cuda-malloc '
  + '--front-end-version Comfy-Org/ComfyUI_frontend@v1.42.2';

/** Args --listen and --port are fixed in the entrypoint; never emit via CLI. */
export const FIXED_IN_ENTRYPOINT = new Set(['--listen', '--port']);

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
    { key: '--normalvram', enabled: false, type: 'flag', description: 'Force normal VRAM (overrides auto-lowvram)', category: 'vram', order: 102 },
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
