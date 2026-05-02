// Plugin README scanner for the auto-resolve chain.
//
// Many ComfyUI plugin authors document their model URLs in the plugin's
// README (e.g. `kijai/ComfyUI-WanAnimatePreprocess` lists the canonical
// `Wan-AI/Wan2.2-Animate-14B/.../yolov10m.onnx` URL). HF's search-by-filename
// can't find these because the file is buried in a subfolder of a repo whose
// name doesn't match the filename — but the plugin author already knows the
// answer.
//
// For each plugin the workflow declares as required, fetch its README from
// GitHub raw, harvest every HF / civitai URL, and match basenames against
// the missing filename. First match wins; resolve via the existing
// `resolveHuggingfaceUrl` / `resolveCivitaiUrl` paths so gating and metadata
// work the same as a manual paste.
//
// Cache key: `owner/repo`. Value: list of harvested URLs, OR null on
// permanent failure (404 / network error) so we don't retry.

import { logger } from '../../lib/logger.js';
import { resolveHuggingfaceUrl, type ResolvedModel } from '../models/resolveHuggingface.js';
import { resolveCivitaiUrl } from '../models/resolveCivitai.js';

const REQUEST_TIMEOUT_MS = 4000;

export type PluginReadmeCache = Map<string, string[] | null>;

function timedFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url).finally(() => clearTimeout(t));
}

function urlBasename(raw: string): string | null {
  try {
    const u = new URL(raw);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function sameFile(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

const URL_RE = /https?:\/\/(?:huggingface\.co|civitai\.com)\/[^\s)\]<>"']+/gi;

function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    // Strip trailing punctuation from URLs that landed at end of a markdown
    // sentence (`...x.onnx)`, `...y.onnx.`).
    const cleaned = m[0].replace(/[)\].,;:!?]+$/, '');
    seen.add(cleaned);
  }
  return Array.from(seen);
}

/** Fetch the plugin's README from GitHub raw and extract HF/civitai URLs.
 *  Tries common branch + filename variants; returns the first non-empty hit. */
async function fetchReadmeUrls(repo: string): Promise<string[] | null> {
  const variants = [
    `https://raw.githubusercontent.com/${repo}/main/README.md`,
    `https://raw.githubusercontent.com/${repo}/main/readme.md`,
    `https://raw.githubusercontent.com/${repo}/master/README.md`,
    `https://raw.githubusercontent.com/${repo}/master/readme.md`,
  ];
  for (const url of variants) {
    try {
      const res = await timedFetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const urls = extractUrls(text);
      if (urls.length > 0) return urls;
    } catch {
      // try next variant
    }
  }
  return null;
}

/**
 * For each plugin repo declared by the workflow, fetch the README and look
 * for a URL whose basename matches `filename`. First match wins. Returns
 * `null` when no plugin's README mentions the file.
 */
export async function pluginReadmeFindUrl(
  filename: string,
  pluginRepos: string[],
  cache: PluginReadmeCache,
): Promise<ResolvedModel | null> {
  for (const repo of pluginRepos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    let urls = cache.get(repo);
    if (urls === undefined) {
      urls = await fetchReadmeUrls(repo);
      cache.set(repo, urls);
    }
    if (!urls || urls.length === 0) continue;
    for (const raw of urls) {
      const base = urlBasename(raw);
      if (!base || !sameFile(base, filename)) continue;
      try {
        const host = new URL(raw).hostname;
        if (/huggingface\.co$/i.test(host)) {
          const r = await resolveHuggingfaceUrl(raw);
          if (r && sameFile(r.fileName, filename)) return r;
        } else if (/civitai\.com$/i.test(host)) {
          const r = await resolveCivitaiUrl(raw);
          if (r && sameFile(r.fileName, filename)) return r;
        }
      } catch (err) {
        logger.warn('pluginReadme: resolve failed', {
          repo, url: raw,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return null;
}
