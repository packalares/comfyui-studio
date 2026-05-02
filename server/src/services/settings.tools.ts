// Chat-tools / integrations settings. Kept in a sibling file so the main
// `settings.ts` stays under the 250-line cap. Shares the in-memory cache +
// atomic-write machinery via `_loadInternal` / `_saveInternal`, so callers
// observe a single canonical settings JSON on disk.
//
// An empty value for any of these means the corresponding chat tool is hidden
// from the LLM's tool set entirely (see `services/chat/tools/index.ts`).

import { _loadInternal, _saveInternal, type SettingsInternal } from './settings.js';

function update(patch: Partial<SettingsInternal>): void {
  _saveInternal({ ..._loadInternal(), ...patch });
}

function dropKey<K extends keyof SettingsInternal>(key: K): void {
  const next = { ..._loadInternal() };
  delete next[key];
  _saveInternal(next);
}

function readTrimmedUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (t.length === 0) return undefined;
  // Match the convention used by getOllamaUrl: persist whatever the user
  // typed but always strip a trailing slash before returning so callers
  // don't end up with `//search` style paths.
  return t.replace(/\/+$/, '');
}

export function getSearxngUrl(): string | undefined {
  return readTrimmedUrl(_loadInternal().searxngUrl);
}

export function setSearxngUrl(url: string): void {
  update({ searxngUrl: url });
}

export function clearSearxngUrl(): void {
  dropKey('searxngUrl');
}

export function getRagflowUrl(): string | undefined {
  return readTrimmedUrl(_loadInternal().ragflowUrl);
}

export function setRagflowUrl(url: string): void {
  update({ ragflowUrl: url });
}

export function clearRagflowUrl(): void {
  dropKey('ragflowUrl');
}

export function getRagflowApiKey(): string | undefined {
  const v = _loadInternal().ragflowApiKey;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function isRagflowApiKeyConfigured(): boolean {
  return typeof getRagflowApiKey() === 'string';
}

export function setRagflowApiKey(key: string): void {
  update({ ragflowApiKey: key });
}

export function clearRagflowApiKey(): void {
  dropKey('ragflowApiKey');
}

export function getDefaultImageTemplate(): string | undefined {
  const v = _loadInternal().defaultImageTemplate;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function setDefaultImageTemplate(name: string): void {
  update({ defaultImageTemplate: name });
}

export function clearDefaultImageTemplate(): void {
  dropKey('defaultImageTemplate');
}
