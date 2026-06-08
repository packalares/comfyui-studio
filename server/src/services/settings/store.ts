import fs from 'fs';
import { paths } from '../../config/paths.js';
import { env } from '../../config/env.js';
import { atomicWrite } from '../../lib/fs.js';

const CONFIG_FILE = paths.configFile;

export interface SettingsInternal {
  apiKeyComfyOrg?: string;
  huggingFaceToken?: string;
  civitaiToken?: string;
  pexelsApiKey?: string;
  /** GitHub PAT used for github-release downloads + GitHub API auth. */
  githubToken?: string;
  /** Base URL of the local Ollama (or other OpenAI-compatible) LLM backend. */
  ollamaUrl?: string;
  /** Default chat model id. */
  chatDefaultModel?: string;
  /** Default Ollama keep_alive value (e.g. `5m`, `0` to unload immediately). */
  chatKeepAlive?: string;
  /** Base URL of a SearXNG instance with JSON output enabled. */
  searxngUrl?: string;
  /** Template used when `generate_image` runs without an explicit template. */
  defaultImageTemplate?: string;
  /** Default context-window management strategy for new conversations. */
  defaultContextStrategy?: 'sliding' | 'auto';
  // Chat tunables (advanced) — each falls back to its DEFAULT_* constant.
  chatHighWaterPercent?: number;
  chatMaxToolSteps?: number;
  chatLoadingHintMs?: number;
  chatKeepRecent?: number;
  chatTitleTimeoutMs?: number;
  chatSummaryTimeoutMs?: number;
  chatSmartSuggestions?: boolean;
  chatDefaultThinkMode?: 'on' | 'off' | 'auto';
  // Allow `studio_run_skill_script` to run user-installed scripts. Off by default.
  chatEnableUserSkillScripts?: boolean;
  /** Max length of the pending-download wait queue. Excess enqueue calls
   *  surface as 429-style "queue full" errors. Defaults to
   *  `DEFAULT_DOWNLOADS_MAX_QUEUE` when unset. */
  downloadsMaxQueue?: number;
  /** Max concurrent in-flight downloads. Above this, new enqueues wait in
   *  the queue. Defaults to `env.MAX_CONCURRENT_DOWNLOADS` when unset, so
   *  unchanged from the env-only behaviour until the user touches it. */
  downloadsMaxConcurrent?: number;
}

// DEFAULT_OLLAMA_URL respects the OLLAMA_URL env var; persisted setting still wins.
export const DEFAULT_OLLAMA_URL = env.OLLAMA_URL;
export const DEFAULT_CHAT_KEEP_ALIVE = '5m';

export const DEFAULT_CHAT_HIGH_WATER_PERCENT = 80;
export const DEFAULT_CHAT_MAX_TOOL_STEPS = 6;
export const DEFAULT_CHAT_LOADING_HINT_MS = 1500;
export const DEFAULT_CHAT_KEEP_RECENT = 4;
export const DEFAULT_CHAT_TITLE_TIMEOUT_MS = 30_000;
export const DEFAULT_CHAT_SUMMARY_TIMEOUT_MS = 60_000;
export const DEFAULT_CHAT_SMART_SUGGESTIONS = true;
export const DEFAULT_CHAT_DEFAULT_THINK_MODE: 'on' | 'off' | 'auto' = 'auto';

// Backpressure cap for the download wait queue. With MAX_CONCURRENT_DOWNLOADS
// in env governing in-flight slots, this caps how many requests can stack up
// behind those slots before the facade rejects new ones. 50 is large enough
// for normal bulk-install flows but stops runaway loops from accumulating
// unbounded state.
export const DEFAULT_DOWNLOADS_MAX_QUEUE = 50;

let cache: SettingsInternal | null = null;

export function _loadInternal(): SettingsInternal {
  if (cache) return cache;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as SettingsInternal;
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

export function _saveInternal(settings: SettingsInternal): void {
  cache = settings;
  atomicWrite(CONFIG_FILE, JSON.stringify(settings, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
}
