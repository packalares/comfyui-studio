import { _loadInternal, _saveInternal } from './store.js';
import { DEFAULT_OLLAMA_URL, DEFAULT_CHAT_KEEP_ALIVE, DEFAULT_NSFW_BLUR_LEVEL } from './store.js';
import { stripTrailingSlash } from '../../lib/url.js';

export function getApiKey(): string | undefined {
  return _loadInternal().apiKeyComfyOrg;
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  return typeof key === 'string' && key.length > 0;
}

export function setApiKey(key: string): void {
  _saveInternal({ ..._loadInternal(), apiKeyComfyOrg: key });
}

export function clearApiKey(): void {
  const { apiKeyComfyOrg: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getHfToken(): string | undefined {
  return _loadInternal().huggingFaceToken;
}

export function isHfTokenConfigured(): boolean {
  const token = getHfToken();
  return typeof token === 'string' && token.length > 0;
}

export function setHfToken(token: string): void {
  _saveInternal({ ..._loadInternal(), huggingFaceToken: token });
}

export function clearHfToken(): void {
  const { huggingFaceToken: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getCivitaiToken(): string | undefined {
  return _loadInternal().civitaiToken;
}

export function isCivitaiTokenConfigured(): boolean {
  const token = getCivitaiToken();
  return typeof token === 'string' && token.length > 0;
}

export function setCivitaiToken(token: string): void {
  _saveInternal({ ..._loadInternal(), civitaiToken: token });
}

export function clearCivitaiToken(): void {
  const { civitaiToken: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getPexelsApiKey(): string | undefined {
  return _loadInternal().pexelsApiKey;
}

export function isPexelsApiKeyConfigured(): boolean {
  const key = getPexelsApiKey();
  return typeof key === 'string' && key.length > 0;
}

export function setPexelsApiKey(key: string): void {
  _saveInternal({ ..._loadInternal(), pexelsApiKey: key });
}

export function clearPexelsApiKey(): void {
  const { pexelsApiKey: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getGithubToken(): string | undefined {
  return _loadInternal().githubToken;
}

export function isGithubTokenConfigured(): boolean {
  const token = getGithubToken();
  return typeof token === 'string' && token.length > 0;
}

export function setGithubToken(token: string): void {
  _saveInternal({ ..._loadInternal(), githubToken: token });
}

export function clearGithubToken(): void {
  const { githubToken: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getOllamaUrl(): string {
  const v = _loadInternal().ollamaUrl;
  if (typeof v === 'string' && v.trim().length > 0) return stripTrailingSlash(v.trim());
  return DEFAULT_OLLAMA_URL;
}

export function setOllamaUrl(url: string): void {
  _saveInternal({ ..._loadInternal(), ollamaUrl: url });
}

export function clearOllamaUrl(): void {
  const { ollamaUrl: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getChatDefaultModel(): string | undefined {
  const v = _loadInternal().chatDefaultModel;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function setChatDefaultModel(model: string): void {
  _saveInternal({ ..._loadInternal(), chatDefaultModel: model });
}

export function clearChatDefaultModel(): void {
  const { chatDefaultModel: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

export function getChatKeepAlive(): string {
  const v = _loadInternal().chatKeepAlive;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : DEFAULT_CHAT_KEEP_ALIVE;
}

export function setChatKeepAlive(value: string): void {
  _saveInternal({ ..._loadInternal(), chatKeepAlive: value });
}

export function clearChatKeepAlive(): void {
  const { chatKeepAlive: _r, ...rest } = _loadInternal();
  _saveInternal(rest);
}

const VALID_CONTEXT_STRATEGIES: Array<'sliding' | 'auto'> = ['sliding', 'auto'];

export function getDefaultContextStrategy(): 'sliding' | 'auto' {
  const v = _loadInternal().defaultContextStrategy;
  return VALID_CONTEXT_STRATEGIES.includes(v as never) ? v! : 'sliding';
}

export function setDefaultContextStrategy(value: 'sliding' | 'auto'): void {
  if (!VALID_CONTEXT_STRATEGIES.includes(value)) return;
  _saveInternal({ ..._loadInternal(), defaultContextStrategy: value });
}

/**
 * NSFW blur threshold: images at or above this level are blurred in the UI.
 * 0 = blur all NSFW, 1 = PG13 (default), 2 = R, 3 = X, 4 = never blur.
 */
export function getNsfwBlurLevel(): number {
  const v = _loadInternal().nsfwBlurLevel;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4) return v;
  return DEFAULT_NSFW_BLUR_LEVEL;
}

export function setNsfwBlurLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > 4) return;
  _saveInternal({ ..._loadInternal(), nsfwBlurLevel: level });
}

