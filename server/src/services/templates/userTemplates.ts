// User-imported workflow templates.
//
// Each file under `paths.userTemplatesDir` is a TemplateData JSON document
// whose shape mirrors upstream ComfyUI templates. On load, every file is
// merged into the in-memory cache so the Studio / Explore pages render them
// identically to upstream entries — the same form-inputs pipeline runs on
// them via `generateFormInputs`.
//
// File names: we derive a slug from the supplied `name` (or fallback to the
// civitai version id). Slugs are sanitized: lowercased, trimmed,
// non-alphanumeric → `-`. This slug is also the template's `name` key (the
// same value Studio routes on via `/studio/:name`).

import fs from 'fs';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { generateFormInputs } from './templates.formInputs.js';
import { readMeta, writeMeta, deleteMeta } from './userTemplatesMeta.js';
import { WorkflowNameCollisionError } from './errors.js';
import type { TemplateData, RawTemplate, TemplatePluginEntry, TemplateCivitaiMeta } from './types.js';

const DIR = (): string => paths.userTemplatesDir;

export function slugifyTemplateName(raw: string): string {
  const s = (raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 120) : 'imported-workflow';
}

function filePath(name: string): string {
  return safeResolve(DIR(), `${name}.json`);
}

function ensureDir(): void {
  try { fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
}

/**
 * Build a TemplateData record from a civitai workflow JSON + display metadata.
 * The civitai workflow JSON is a LiteGraph document; we keep it in the
 * `workflow` field and let `generateFormInputs` derive form-level metadata
 * from the raw template shape.
 */
export interface SaveWorkflowInput {
  name: string;
  title: string;
  description?: string;
  workflow: Record<string, unknown>;
  sourceUrl?: string;
  tags?: string[];
  category?: string;
  /**
   * Pre-extracted io.inputs/outputs. When omitted, the template lands with
   * an empty io block and the form-inputs generator falls back to a generic
   * prompt (back-compat with single-JSON civitai imports).
   */
  io?: TemplateData['io'];
  /** Derived media type (SaveImage→image, SaveVideo→video, ...). Defaults to 'image'. */
  mediaType?: string;
  /** Studio sidebar bucket. Defaults to 'image'. */
  studioCategory?: TemplateData['studioCategory'];
  /** Model filenames the workflow depends on — prepopulates TemplateData.models. */
  models?: string[];
  /**
   * Resolved plugin requirements (Phase 2). Persisted into TemplateData so
   * the Explore card + Studio page can surface "N plugins missing" without
   * re-running the Manager lookup on every render.
   */
  plugins?: TemplatePluginEntry[];
  /**
   * Optional thumbnail URL(s). When set, the first entry is used as the
   * card preview (via the existing `template.thumbnail[0]` render).
   */
  thumbnail?: string[];
  /**
   * Optional CivitAI origin metadata. Persisted as a `meta.json` sidecar
   * next to the workflow so the listing endpoint can surface it on the
   * TemplateCard without reparsing every workflow document.
   */
  civitaiMeta?: TemplateCivitaiMeta;
}

/**
 * Find the next available slug suffix when `<slug>.json` is already on disk.
 * Returns `<slug>-2`, `<slug>-3`, ... up to a fixed cap so a pathological
 * collection of past imports can't lock the loop. The cap is far above any
 * realistic per-base count and only exists to keep the search bounded.
 */
function nextAvailableSlug(slug: string): string {
  const MAX_ATTEMPTS = 500;
  for (let i = 2; i <= MAX_ATTEMPTS; i += 1) {
    const candidate = `${slug}-${i}`;
    if (!fs.existsSync(filePath(candidate))) return candidate;
  }
  return `${slug}-${MAX_ATTEMPTS + 1}`;
}

export function saveUserWorkflow(input: SaveWorkflowInput): TemplateData {
  ensureDir();
  const slug = slugifyTemplateName(input.name);

  // Refuse to silently overwrite an existing user workflow. The route layer
  // turns this into a 409 with a `suggestedSlug` payload so the UI can
  // offer a one-click retry under the suggested name.
  if (fs.existsSync(filePath(slug))) {
    throw new WorkflowNameCollisionError(slug, nextAvailableSlug(slug));
  }

  const mediaType = input.mediaType || 'image';
  // The form-inputs generator works off a RawTemplate shape. Synthesise one
  // from the inputs we have — including any pre-extracted io.inputs — so
  // user-imported templates get the same image/video/audio upload fields
  // as upstream ComfyUI templates with the same shape.
  const raw: RawTemplate = {
    name: slug,
    title: input.title || slug,
    description: input.description || '',
    mediaType,
    tags: input.tags || [],
    models: input.models || [],
    date: new Date().toISOString(),
    openSource: true,
    io: input.io,
  };
  const data: TemplateData = {
    name: slug,
    title: raw.title,
    description: raw.description,
    mediaType,
    tags: raw.tags ?? [],
    models: input.models ?? [],
    plugins: input.plugins,
    category: input.category || 'User Workflows',
    studioCategory: input.studioCategory ?? 'image',
    io: input.io ?? { inputs: [], outputs: [] },
    // Pass the user's workflow so the primitive-titled fields (Width /
    // Height / Prompt / ...) land in `formInputs` at save time. No objectInfo
    // here — the widget-walk for multi-field encoders runs dynamically in
    // the /template-widgets route where objectInfo is available.
    formInputs: generateFormInputs(raw, input.workflow),
    thumbnail: input.thumbnail ?? [],
    workflow: input.workflow,
    size: 0,
    vram: 0,
    usage: 0,
    openSource: true,
    date: raw.date,
  };
  if (input.civitaiMeta) data.civitaiMeta = input.civitaiMeta;
  try {
    atomicWrite(filePath(slug), JSON.stringify({ ...data, sourceUrl: input.sourceUrl }, null, 2), {
      mode: 0o644, dirMode: 0o700,
    });
  } catch (err) {
    logger.error('user workflow save failed', { slug, error: String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (input.civitaiMeta) writeMeta(slug, input.civitaiMeta);
  return data;
}

export function listUserWorkflows(): TemplateData[] {
  try {
    if (!fs.existsSync(DIR())) return [];
    // Filter out the `.meta.json` sidecars so they aren't parsed as templates.
    const files = fs.readdirSync(DIR()).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.meta.json'),
    );
    const out: TemplateData[] = [];
    for (const f of files) {
      try {
        const abs = safeResolve(DIR(), f);
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = JSON.parse(raw) as TemplateData;
        // Strip any `sourceUrl` sidecar that's not part of TemplateData.
        // Overlay civitaiMeta from the meta sidecar when present (sidecar
        // wins over any field embedded in the template JSON).
        const meta = readMeta(parsed.name);
        if (meta) parsed.civitaiMeta = meta;
        out.push(parsed);
      } catch (err) {
        logger.warn('user workflow load failed', { file: f, error: String(err) });
      }
    }
    return out;
  } catch (err) {
    logger.error('user workflow list failed', { error: String(err) });
    return [];
  }
}

export function deleteUserWorkflow(name: string): boolean {
  try {
    const abs = filePath(name);
    if (!fs.existsSync(abs)) return false;
    fs.rmSync(abs, { force: true });
    deleteMeta(name);
    return true;
  } catch (err) {
    logger.error('user workflow delete failed', { name, error: String(err) });
    return false;
  }
}

export function isUserWorkflow(name: string): boolean {
  try {
    const abs = filePath(name);
    return fs.existsSync(abs);
  } catch { return false; }
}

/**
 * Return just the `workflow` JSON for a user-imported template. The generate
 * endpoint uses this to bypass ComfyUI's `/templates/:name.json` lookup for
 * templates that only exist on our side (ComfyUI doesn't know about them).
 */
export function getUserWorkflowJson(name: string): Record<string, unknown> | null {
  try {
    const abs = filePath(name);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw) as { workflow?: unknown };
    if (!parsed.workflow || typeof parsed.workflow !== 'object') return null;
    return parsed.workflow as Record<string, unknown>;
  } catch (err) {
    logger.error('user workflow read failed', { name, error: String(err) });
    return null;
  }
}
