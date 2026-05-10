import { _loadInternal, _saveInternal, type SettingsInternal } from './store.js';
import { stripTrailingSlash } from '../../lib/url.js';

function update(patch: Partial<SettingsInternal>): void {
  _saveInternal({ ..._loadInternal(), ...patch });
}

function dropKey<K extends keyof SettingsInternal>(key: K): void {
  const next = { ..._loadInternal() };
  delete next[key];
  _saveInternal(next);
}

// Trim + return undefined on blank. Plain non-URL strings (template names, ids).
function readTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

// As above + strip trailing slashes. URL-shaped settings only.
function readTrimmedUrl(value: string | undefined): string | undefined {
  const t = readTrimmed(value);
  return t === undefined ? undefined : stripTrailingSlash(t);
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

export function getDefaultImageTemplate(): string | undefined {
  return readTrimmed(_loadInternal().defaultImageTemplate);
}

export function setDefaultImageTemplate(name: string): void {
  update({ defaultImageTemplate: name });
}

export function clearDefaultImageTemplate(): void {
  dropKey('defaultImageTemplate');
}

// `enabledMcpTools` is an extension of SettingsInternal not yet in the core type.
type WithMcpTools = SettingsInternal & { enabledMcpTools?: Record<string, boolean> };

export function getEnabledMcpTools(): Record<string, boolean> {
  const v = (_loadInternal() as WithMcpTools).enabledMcpTools;
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
}

export function setEnabledMcpTools(map: Record<string, boolean>): void {
  _saveInternal({ ...(_loadInternal() as WithMcpTools), enabledMcpTools: map } as SettingsInternal);
}
