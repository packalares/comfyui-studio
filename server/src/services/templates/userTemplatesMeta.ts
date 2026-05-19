// Civitai origin-meta sidecar helpers for user-imported workflows.
//
// Split from `userTemplates.ts` so that file stays under the structure
// test's 250-line cap. The sidecar sits next to the template JSON as
// `<slug>.meta.json`; `listUserWorkflows()` overlays it onto the in-memory
// TemplateData after loading the main document.

import fs from 'fs';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import type { TemplateCivitaiMeta, TemplateData } from './types.js';

const DIR = (): string => paths.userTemplatesDir;

/** Shape of the sidecar we write to disk. */
export interface StoredMeta {
  source: 'civitai';
  modelId: number;
  tags?: string[];
  description?: string;
  originalUrl?: string;
}

/** Sidecar path for the civitai origin meta. */
export function metaFilePath(name: string): string {
  return safeResolve(DIR(), `${name}.meta.json`);
}

/** Read the civitai meta sidecar for a slug; returns null when missing. */
export function readMeta(slug: string): TemplateCivitaiMeta | null {
  try {
    const abs = metaFilePath(slug);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw) as StoredMeta;
    if (parsed.source !== 'civitai' || typeof parsed.modelId !== 'number') return null;
    const out: TemplateCivitaiMeta = { modelId: parsed.modelId };
    if (Array.isArray(parsed.tags)) out.tags = parsed.tags;
    if (typeof parsed.description === 'string') out.description = parsed.description;
    if (typeof parsed.originalUrl === 'string') out.originalUrl = parsed.originalUrl;
    return out;
  } catch (err) {
    logger.warn('user workflow meta read failed', { slug, error: String(err) });
    return null;
  }
}

/** Write the civitai meta sidecar atomically. Best-effort — swallows I/O errors. */
export function writeMeta(slug: string, meta: TemplateCivitaiMeta): void {
  const stored: StoredMeta = { source: 'civitai', modelId: meta.modelId };
  if (meta.tags && meta.tags.length > 0) stored.tags = meta.tags;
  if (meta.description) stored.description = meta.description;
  if (meta.originalUrl) stored.originalUrl = meta.originalUrl;
  try {
    atomicWrite(metaFilePath(slug), JSON.stringify(stored, null, 2), {
      mode: 0o644, dirMode: 0o700,
    });
  } catch (err) {
    logger.warn('user workflow meta write failed', { slug, error: String(err) });
  }
}

/** Best-effort delete for the sidecar; missing sidecar is expected. */
export function deleteMeta(slug: string): void {
  try {
    const abs = metaFilePath(slug);
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
  } catch { /* best effort */ }
}

/**
 * Read the full TemplateData for a named template from its disk JSON.
 * Returns null when no file exists for that name. Unlike the old in-memory
 * cache this always returns up-to-date disk state.
 */
export function getUserTemplate(name: string): TemplateData | null {
  try {
    const abs = safeResolve(DIR(), `${name}.json`);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw) as TemplateData;
    const meta = readMeta(parsed.name);
    if (meta) parsed.civitaiMeta = meta;
    return parsed;
  } catch (err) {
    logger.warn('user template read failed', { name, error: String(err) });
    return null;
  }
}
