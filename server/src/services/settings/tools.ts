import {
  _loadInternal, _saveInternal, type SettingsInternal,
  DEFAULT_DOCLING_FILE_TYPES, DEFAULT_DOCLING_MAX_UPLOAD_MB,
} from './store.js';
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

// ---- Docling document parser (LLM-API file ingestion) ----

export function getDoclingUrl(): string | undefined {
  return readTrimmedUrl(_loadInternal().doclingUrl);
}
export function setDoclingUrl(url: string): void {
  update({ doclingUrl: url });
}
export function clearDoclingUrl(): void {
  dropKey('doclingUrl');
}

/** Accepted extensions (lowercase, no dot). Falls back to the default set. */
export function getDoclingFileTypes(): string[] {
  const v = _loadInternal().doclingFileTypes;
  if (Array.isArray(v) && v.length > 0) {
    return v.map((s) => String(s).toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
  }
  return [...DEFAULT_DOCLING_FILE_TYPES];
}
export function setDoclingFileTypes(types: string[]): void {
  const cleaned = types
    .map((s) => s.toLowerCase().replace(/^\./, '').trim())
    .filter(Boolean);
  update({ doclingFileTypes: Array.from(new Set(cleaned)) });
}

export function getDoclingMaxUploadMb(): number {
  const v = _loadInternal().doclingMaxUploadMb;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_DOCLING_MAX_UPLOAD_MB;
}
export function setDoclingMaxUploadMb(mb: number): void {
  update({ doclingMaxUploadMb: mb });
}

// ---- docscanner image dewarp/cleanup (LLM-API vision preprocessing) ----

export function getDocscannerUrl(): string | undefined {
  return readTrimmedUrl(_loadInternal().docscannerUrl);
}
export function setDocscannerUrl(url: string): void {
  update({ docscannerUrl: url });
}
export function clearDocscannerUrl(): void {
  dropKey('docscannerUrl');
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
