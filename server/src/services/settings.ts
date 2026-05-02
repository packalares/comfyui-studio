import fs from 'fs';
import { paths } from '../config/paths.js';
import { atomicWrite } from '../lib/fs.js';

const CONFIG_FILE = paths.configFile;

interface Settings {
  apiKeyComfyOrg?: string;
  huggingFaceToken?: string;
  civitaiToken?: string;
  pexelsApiKey?: string;
  /** GitHub PAT used for github-release downloads + (already-existing) GitHub API auth. */
  githubToken?: string;
  /** Base URL of the local Ollama (or other OpenAI-compatible) LLM backend. */
  ollamaUrl?: string;
  /** Default chat model id (e.g. `llama3.3:70b-instruct-q4_K_M`). */
  chatDefaultModel?: string;
  /** Default Ollama keep_alive value (e.g. `5m`, `0` to unload immediately). */
  chatKeepAlive?: string;
  /** Base URL of a SearXNG instance with JSON output enabled. */
  searxngUrl?: string;
  /** Base URL of a RAGFlow instance (e.g. `https://ragflow.example.com`). */
  ragflowUrl?: string;
  /** RAGFlow API key — sent as `Authorization: Bearer <key>` on every call. */
  ragflowApiKey?: string;
  /** Template name used when the chat `generate_image` tool runs without an explicit template. */
  defaultImageTemplate?: string;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_CHAT_KEEP_ALIVE = '5m';

let cache: Settings | null = null;

function load(): Settings {
  if (cache) return cache;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      cache = JSON.parse(raw) as Settings;
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

function save(settings: Settings): void {
  cache = settings;
  atomicWrite(CONFIG_FILE, JSON.stringify(settings, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
}

export function getApiKey(): string | undefined {
  return load().apiKeyComfyOrg;
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  return typeof key === 'string' && key.length > 0;
}

export function setApiKey(key: string): void {
  const settings = load();
  save({ ...settings, apiKeyComfyOrg: key });
}

export function clearApiKey(): void {
  const settings = load();
  const { apiKeyComfyOrg: _removed, ...rest } = settings;
  save(rest);
}

export function getHfToken(): string | undefined {
  return load().huggingFaceToken;
}

export function isHfTokenConfigured(): boolean {
  const token = getHfToken();
  return typeof token === 'string' && token.length > 0;
}

export function setHfToken(token: string): void {
  const settings = load();
  save({ ...settings, huggingFaceToken: token });
}

export function clearHfToken(): void {
  const settings = load();
  const { huggingFaceToken: _removed, ...rest } = settings;
  save(rest);
}

export function getCivitaiToken(): string | undefined {
  return load().civitaiToken;
}

export function isCivitaiTokenConfigured(): boolean {
  const token = getCivitaiToken();
  return typeof token === 'string' && token.length > 0;
}

export function setCivitaiToken(token: string): void {
  const settings = load();
  save({ ...settings, civitaiToken: token });
}

export function clearCivitaiToken(): void {
  const settings = load();
  const { civitaiToken: _removed, ...rest } = settings;
  save(rest);
}

export function getPexelsApiKey(): string | undefined {
  return load().pexelsApiKey;
}

export function isPexelsApiKeyConfigured(): boolean {
  const key = getPexelsApiKey();
  return typeof key === 'string' && key.length > 0;
}

export function setPexelsApiKey(key: string): void {
  const settings = load();
  save({ ...settings, pexelsApiKey: key });
}

export function clearPexelsApiKey(): void {
  const settings = load();
  const { pexelsApiKey: _removed, ...rest } = settings;
  save(rest);
}

export function getGithubToken(): string | undefined {
  return load().githubToken;
}

export function isGithubTokenConfigured(): boolean {
  const token = getGithubToken();
  return typeof token === 'string' && token.length > 0;
}

export function setGithubToken(token: string): void {
  const settings = load();
  save({ ...settings, githubToken: token });
}

export function clearGithubToken(): void {
  const settings = load();
  const { githubToken: _removed, ...rest } = settings;
  save(rest);
}

export function getOllamaUrl(): string {
  const v = load().ollamaUrl;
  if (typeof v === 'string' && v.trim().length > 0) return v.trim().replace(/\/+$/, '');
  return DEFAULT_OLLAMA_URL;
}

export function setOllamaUrl(url: string): void {
  const settings = load();
  save({ ...settings, ollamaUrl: url });
}

export function clearOllamaUrl(): void {
  const settings = load();
  const { ollamaUrl: _removed, ...rest } = settings;
  save(rest);
}

export function getChatDefaultModel(): string | undefined {
  const v = load().chatDefaultModel;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function setChatDefaultModel(model: string): void {
  const settings = load();
  save({ ...settings, chatDefaultModel: model });
}

export function clearChatDefaultModel(): void {
  const settings = load();
  const { chatDefaultModel: _removed, ...rest } = settings;
  save(rest);
}

export function getChatKeepAlive(): string {
  const v = load().chatKeepAlive;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : DEFAULT_CHAT_KEEP_ALIVE;
}

export function setChatKeepAlive(value: string): void {
  const settings = load();
  save({ ...settings, chatKeepAlive: value });
}

export function clearChatKeepAlive(): void {
  const settings = load();
  const { chatKeepAlive: _removed, ...rest } = settings;
  save(rest);
}

// Internal accessors used by `settings.tools.ts` so the chat-tools fields share
// the same in-memory cache + atomic-write machinery without re-implementing it.
export function _loadInternal(): Settings { return load(); }
export function _saveInternal(next: Settings): void { save(next); }
export type SettingsInternal = Settings;
