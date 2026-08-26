// Persist `template_presets[]` from an Easy-mode template import.
//
// Called by importCommit after the parent has been saved + the DB row
// upserted. We:
//   1. Build the per-parent folder under `<userTemplatesDir>/<name>/`.
//   2. For each preset:
//      - Generate a 10-char base62 id when the import didn't carry one.
//      - Download `previewUrl` → save as `<id>.<ext>` next to the JSON.
//      - Write `<id>.json` containing the preset's `settings` block.
//   3. Build the display-card array (id, title, description, LOCAL
//      previewUrl pointing at /api/thumbnail/preset/..., published, tool)
//      and persist into the `templates.template_presets` JSON column.
//
// Best-effort: any per-preset failure is logged and that preset is dropped
// from the card list, but the rest of the import keeps going. Returning a
// partial list is preferable to crashing the parent import over one bad
// thumbnail URL.

import fs from 'fs';
import path from 'path';
import { randomInt } from 'crypto';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { setPresets, type PresetCard } from '../../lib/db/templatePresets.repo.js';

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Shape of one entry coming off the import JSON's `template_presets[]`. The
 *  importer is forgiving — missing fields get sensible defaults, unknown
 *  fields are ignored. `settings` is whatever the original Pikaso-style
 *  payload had; we persist it verbatim to disk so the click-to-load endpoint
 *  has everything it needs to fill the form later. */
export interface RawPresetImport {
  id?: string;
  title?: string;
  description?: string;
  previewUrl?: string;
  published?: boolean;
  tool?: string;
  settings?: Record<string, unknown>;
  // Forward-compat: keep anything else around if the importer cares to
  // persist it in the on-disk JSON.
  [extra: string]: unknown;
}

function newId(used: Set<string>): string {
  while (true) {
    let out = '';
    for (let i = 0; i < 10; i++) {
      // randomInt is rejection-sampled — no modulo bias across ALPHABET.
      out += ALPHABET[randomInt(ALPHABET.length)];
    }
    if (!used.has(out)) {
      used.add(out);
      return out;
    }
  }
}

/** Best-effort extension derivation: trust the URL pathname first, then fall
 *  back to the response content-type. Default `.jpg` so the file is always
 *  recognisable by the thumbnail pipeline (image-pipeline accepts jpg). */
function extensionForPreview(url: string, contentType: string | null): string {
  const cleaned = url.split('?')[0].split('#')[0];
  const last = cleaned.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot > 0) {
    const ext = last.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  if (contentType) {
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('avif')) return 'avif';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  }
  return 'jpg';
}

/** Decode a `data:<mime>;base64,<payload>` URL into bytes + the MIME type
 *  declared in the prefix. Supports the `base64` variant only — percent-
 *  encoded data URLs are rare for images and unsupported here. Returns
 *  null on any parse failure (logged by the caller). */
function decodeDataUrl(url: string): { bytes: Buffer; contentType: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const isBase64 = match[2] === ';base64';
  if (!isBase64) return null;
  const contentType = (match[1] || 'application/octet-stream').toLowerCase();
  try {
    return { bytes: Buffer.from(match[3], 'base64'), contentType };
  } catch {
    return null;
  }
}

async function downloadPreview(
  url: string,
  destAbsPath: string,
): Promise<{ filename: string } | null> {
  // Inline `data:image/...;base64,...` URLs skip the network — decode the
  // payload in-process. Lets templates ship their previews embedded in
  // the JSON instead of relying on an external CDN.
  if (url.startsWith('data:')) {
    const decoded = decodeDataUrl(url);
    if (!decoded) {
      logger.warn('preset preview data URL malformed', { previewUrlHead: url.slice(0, 32) });
      return null;
    }
    if (decoded.bytes.byteLength > MAX_PREVIEW_BYTES) {
      logger.warn('preset preview data URL exceeds size cap', { size: decoded.bytes.byteLength });
      return null;
    }
    const ext = extensionForPreview('', decoded.contentType);
    const finalAbs = `${destAbsPath}.${ext}`;
    try {
      fs.writeFileSync(finalAbs, decoded.bytes, { mode: 0o600 });
    } catch (err) {
      logger.warn('preset preview write failed', { dest: finalAbs, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    return { filename: path.basename(finalAbs) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    logger.warn('preset preview fetch failed', { url, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  clearTimeout(timer);
  if (!res.ok) {
    logger.warn('preset preview non-2xx', { url, status: res.status });
    return null;
  }
  const declared = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
    logger.warn('preset preview exceeds size cap', { url, declared });
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_PREVIEW_BYTES) {
    logger.warn('preset preview exceeds size cap (post-read)', { url, size: bytes.byteLength });
    return null;
  }
  const ext = extensionForPreview(url, res.headers.get('content-type'));
  const finalAbs = `${destAbsPath}.${ext}`;
  try {
    fs.writeFileSync(finalAbs, bytes, { mode: 0o600 });
  } catch (err) {
    logger.warn('preset preview write failed', { dest: finalAbs, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  return { filename: path.basename(finalAbs) };
}

/** Persist all `template_presets[]` entries for `parentName`. Returns the
 *  number of cards persisted (0 means either no input or all failed). */
export async function persistTemplatePresets(
  parentName: string,
  presets: RawPresetImport[],
): Promise<number> {
  if (!Array.isArray(presets) || presets.length === 0) return 0;

  // Per-parent folder. Mode 0o700 matches userTemplatesDir's perms.
  let folderAbs: string;
  try {
    folderAbs = safeResolve(paths.userTemplatesDir, parentName);
  } catch (err) {
    logger.warn('preset folder resolve failed — skipping presets', {
      parentName, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  try {
    fs.mkdirSync(folderAbs, { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn('preset folder create failed — skipping presets', {
      parentName, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const usedIds = new Set<string>();
  const cards: PresetCard[] = [];

  for (const entry of presets) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id.length > 0
      ? (usedIds.add(entry.id), entry.id)
      : newId(usedIds);
    const title = typeof entry.title === 'string' ? entry.title : id;

    // Per-preset settings JSON — write first so even if the preview download
    // bombs we still have the form-filling payload on disk.
    const settings = (entry.settings && typeof entry.settings === 'object') ? entry.settings : {};
    try {
      const jsonAbs = path.join(folderAbs, `${id}.json`);
      fs.writeFileSync(jsonAbs, JSON.stringify(settings, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.warn('preset settings write failed — skipping preset', {
        parentName, id, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Optional preview download. URL is REPLACED in the card with a local
    // thumbnail-API route — the original (token-bearing) URL never lands in
    // the DB.
    let previewLocal: string | null = null;
    if (typeof entry.previewUrl === 'string' && entry.previewUrl.length > 0) {
      const downloaded = await downloadPreview(
        entry.previewUrl,
        path.join(folderAbs, id),
      );
      if (downloaded) {
        previewLocal = `/api/thumbnail/preset/${encodeURIComponent(parentName)}/${encodeURIComponent(downloaded.filename)}`;
      }
    }

    const card: PresetCard = { id, title };
    if (typeof entry.description === 'string') card.description = entry.description;
    if (previewLocal) card.previewUrl = previewLocal;
    if (typeof entry.published === 'boolean') card.published = entry.published;
    if (typeof entry.tool === 'string') card.tool = entry.tool;
    cards.push(card);
  }

  if (cards.length === 0) return 0;
  try {
    setPresets(parentName, cards);
  } catch (err) {
    logger.warn('preset column write failed', {
      parentName, count: cards.length, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  return cards.length;
}
