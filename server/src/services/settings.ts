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
}

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
