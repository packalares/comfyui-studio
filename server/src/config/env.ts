// Centralised, typed environment loader. Every `process.env.*` read across
// `server/src/**` flows through this module; direct access is forbidden.
//
// Rules:
// - Defaults listed here MUST match the prior inline defaults so behaviour is
//   unchanged.
// - Never throw at import time: unset vars resolve to their defaults (or empty
//   strings where that was the pre-refactor behaviour).

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readPort(): number {
  // Back-compat: BACKEND_PORT wins over PORT when both are set.
  const backend = process.env.BACKEND_PORT;
  const fallback = process.env.PORT;
  const raw = backend ?? fallback;
  const n = raw ? parseInt(raw, 10) : 3002;
  return Number.isFinite(n) && n > 0 ? n : 3002;
}

// --- studio-native settings ---
const STUDIO = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: readPort(),
  COMFYUI_URL: process.env.COMFYUI_URL ?? 'http://localhost:8188',
  /** Root of ComfyUI's model tree on disk. Empty string disables stat-fallback. */
  MODELS_DIR: process.env.MODELS_DIR ?? '',
  MAX_CONCURRENT_DOWNLOADS: readNumber(process.env.MAX_CONCURRENT_DOWNLOADS, 2),
  /** Absolute path to the persisted catalog JSON. Resolved in `paths.ts`. */
  STUDIO_CATALOG_FILE: process.env.STUDIO_CATALOG_FILE,
  /** Absolute path to persisted user settings JSON. Resolved in `paths.ts`. */
  STUDIO_CONFIG_FILE: process.env.STUDIO_CONFIG_FILE,
  /** Directory holding per-template exposed-widget records. Resolved in `paths.ts`. */
  STUDIO_EXPOSED_WIDGETS_DIR: process.env.STUDIO_EXPOSED_WIDGETS_DIR,
  /** Absolute path to the sqlite database file. Resolved in `paths.ts`. */
  STUDIO_SQLITE_PATH: process.env.STUDIO_SQLITE_PATH,
  /** Max multipart upload size in bytes. Default 500 MiB — covers images
   * and common video clips. Real enforcement is here, not nginx. */
  UPLOAD_MAX_BYTES: readNumber(process.env.UPLOAD_MAX_BYTES, 500 * 1024 * 1024),
  /**
   * CORS allow-list. Unset => permissive (current pod-internal behavior).
   * Set to a single origin or comma-separated list when exposing externally.
   */
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  /** Origin allow-list for WS upgrades. Unset => permissive. */
  WS_ORIGIN: process.env.WS_ORIGIN,
  /** Logger threshold: error | warn | info | debug. Default info. */
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
} as const;

// --- ComfyUI + system integration vars (consumed by services/*) ---
// Defaults are preserved from the pre-cutover inline fallbacks so studio
// behaviour is unchanged when these are unset.
const LAUNCHER = {
  /** ComfyUI on-disk install root. Consumed by models + plugin + python services. */
  COMFYUI_PATH: process.env.COMFYUI_PATH ?? '/root/ComfyUI',
  /** Launcher data/cache root (download history, plugin history). */
  DATA_DIR: process.env.DATA_DIR ?? '',
  /** Custom Python interpreter for ComfyUI runtime commands. */
  PYTHON_PATH: process.env.PYTHON_PATH ?? 'python3',
  /** ComfyUI custom_nodes directory. Consumed by plugin service. */
  PLUGIN_PATH: process.env.PLUGIN_PATH ?? '',
  /** HuggingFace mirror endpoint base. */
  HF_ENDPOINT: process.env.HF_ENDPOINT ?? '',
  /** GitHub clone/proxy prefix. */
  GITHUB_PROXY: process.env.GITHUB_PROXY ?? '',
  /** pip index URL override. */
  PIP_INDEX_URL: process.env.PIP_INDEX_URL ?? '',
  /** Mount point for the shared model hub (one path, not configurable per-user). */
  SHARED_MODEL_HUB_PATH: process.env.SHARED_MODEL_HUB_PATH ?? '/mnt/olares-shared-model',
  /** Pre-built node list bundled with the launcher; read-only reference. */
  NODE_LIST_PATH: process.env.NODE_LIST_PATH ?? '',
  /** Path where the plugin-cache service writes its mutable JSON. */
  MODEL_CACHE_PATH: process.env.MODEL_CACHE_PATH ?? '',
  /** Path where the plugin-history service writes its mutable JSON. */
  PLUGIN_HISTORY_PATH: process.env.PLUGIN_HISTORY_PATH ?? '',
  /** ComfyUI CLI extra args (launch-options service). */
  CLI_ARGS: process.env.CLI_ARGS ?? '',
  /** Olares system-control server base URL (system controller). */
  OS_SYSTEM_SERVER: process.env.OS_SYSTEM_SERVER ?? '',
  /** Desktop bridge for open-path calls. */
  DESKTOP_API_URL: process.env.DESKTOP_API_URL ?? '',
  /** Node hostname, used in open-path URLs. */
  NODENAME: process.env.NODENAME ?? '',
  /** Admin domain for ComfyUI (used in HTML-generator URL building). */
  DOMAIN_COMFYUI_FOR_ADMIN: process.env.DOMAIN_COMFYUI_FOR_ADMIN ?? '',
  /** Admin domain for the launcher. */
  DOMAIN_LAUNCHER_FOR_ADMIN: process.env.DOMAIN_LAUNCHER_FOR_ADMIN ?? '',
  /** Resource-pack retry policy. */
  RP_RETRY_ATTEMPTS: readNumber(process.env.RP_RETRY_ATTEMPTS, 4),
  RP_RETRY_BASE_DELAY_MS: readNumber(process.env.RP_RETRY_BASE_DELAY_MS, 1000),
  RP_RETRY_BACKOFF: readNumber(process.env.RP_RETRY_BACKOFF, 4),
  RP_RETRY_MAX_DELAY_MS: readNumber(process.env.RP_RETRY_MAX_DELAY_MS, 15000),
  /** ComfyUI's internal HTTP port (default 8188). Used by proxy + isRunning probe. */
  COMFYUI_PORT: readNumber(process.env.COMFYUI_PORT, 8188),
  /** TCP port the Studio opens for the reverse-proxy to ComfyUI. 0 disables. */
  COMFYUI_PROXY_PORT: readNumber(process.env.COMFYUI_PROXY_PORT, 8190),
  /** Path to the ComfyUI runner entrypoint script (launcher's bash runner). */
  COMFYUI_ENTRYPOINT: process.env.COMFYUI_ENTRYPOINT ?? '/runner-scripts/entrypoint.sh',
  /** ComfyUI cache directory (optional, used by reset). */
  CACHE_DIR: process.env.CACHE_DIR ?? '',
  /** Max ComfyUI start retries (5s per retry). Default 120 (~10 min). */
  COMFYUI_START_RETRIES: readNumber(process.env.COMFYUI_START_RETRIES, 120),
  /** Graceful stop wait ms before force kill. Default 2000. */
  COMFYUI_STOP_WAIT_MS: readNumber(process.env.COMFYUI_STOP_WAIT_MS, 2000),
  /** CUDA GPU share mode hint (0 exclusive, 1 memorySlice, 2 timeSlice). */
  CUDA_DEVICE_GPU_MODE_0: process.env.CUDA_DEVICE_GPU_MODE_0 ?? '',
  /** Legacy NVShare managed memory hint (0 independent, 1 shared). */
  NVSHARE_MANAGED_MEMORY: process.env.NVSHARE_MANAGED_MEMORY ?? '',
  /** Extra trusted hostnames for plugin installs (comma-separated). */
  PLUGIN_TRUSTED_HOSTS: process.env.PLUGIN_TRUSTED_HOSTS ?? '',
  /** Initial value for the live "allow http:// pip mirrors on private IPs" toggle. */
  PIP_ALLOW_PRIVATE_IP: String(process.env.PIP_ALLOW_PRIVATE_IP ?? '').toLowerCase() === 'true',
  /** CivitAI API base URL. Defaults to public public endpoint. */
  CIVITAI_API_BASE: process.env.CIVITAI_API_BASE ?? 'https://civitai.com/api/v1',
  /** Maximum proxied CivitAI response size in bytes. Default 10 MiB. */
  CIVITAI_MAX_RESPONSE_BYTES: readNumber(process.env.CIVITAI_MAX_RESPONSE_BYTES, 10 * 1024 * 1024),
  /** CivitAI API token seed (optional). Persisted via `settings.civitaiToken` takes precedence. */
  CIVITAI_TOKEN: process.env.CIVITAI_TOKEN ?? '',
  /**
   * Optional GitHub API token. When set, `Authorization: Bearer <token>` is
   * attached to calls to api.github.com so the import-from-github flow gets
   * the authenticated 5000/h rate limit instead of the unauth 60/h. Never
   * forwarded to the client.
   */
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
  /**
   * Optional HuggingFace API token. When set, `Authorization: Bearer <token>`
   * is attached to calls against huggingface.co by the HF URL resolver so we
   * can HEAD private or size-redirected files. Public endpoints keep working
   * without it. Never forwarded to the client.
   */
  HUGGINGFACE_TOKEN: process.env.HUGGINGFACE_TOKEN ?? '',
  /**
   * Image-proxy allow-list. Hostnames (exact) or leading-dot suffixes
   * (`.civitai.com` matches any subdomain) that the /api/img proxy will
   * fetch from. Separator: comma. Same semantics as vite's `allowedHosts`.
   */
  IMG_PROXY_ALLOWED_HOSTS: (process.env.IMG_PROXY_ALLOWED_HOSTS
    ?? 'civitai.com,.civitai.com,huggingface.co,.huggingface.co,cdn.huggingface.co,image.civitai.com,cdn.civitai.com,localhost,127.0.0.1')
    .split(',').map((s) => s.trim()).filter(Boolean),
} as const;

export const env = { ...STUDIO, ...LAUNCHER } as const;

export type Env = typeof env;

export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Snapshot of the current process environment. Use this from child-process
 * launchers (see `lib/exec.ts`) so they inherit PATH / HOME / etc. without
 * needing their own `process.env` read site — keeps the env-discipline test
 * satisfied (every `process.env.` read lives in this file).
 */
export function currentProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Read the current `STUDIO_SQLITE_PATH` override live. `paths.sqlitePath`
 * resolves through this getter so vitest can swap the DB location between
 * test cases without a module re-import.
 */
export function currentSqliteOverride(): string | undefined {
  return process.env.STUDIO_SQLITE_PATH;
}

/**
 * Wave L test-only toggle. The staging auto-resolve pass skips the
 * HF / CivitAI search steps (3 + 4) in NODE_ENV=test unless this reads
 * `'1'` so test runs don't hang on DNS lookups to huggingface.co. Read
 * live (not at module init) so individual tests can opt in + out.
 */
export function autoResolveSearchEnabled(): boolean {
  return process.env.STUDIO_AUTO_RESOLVE_SEARCH === '1';
}
