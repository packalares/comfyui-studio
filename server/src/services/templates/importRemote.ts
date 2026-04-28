// Remote-URL + paste-JSON → staging helpers. Powers the GitHub and Paste-JSON
// tabs of the import modal. URL normalisation + host allow-list live in
// `importRemote.urls.ts` so this file stays under the structure line cap.
// Security: GitHub-only host allow-list, `hostIsPrivate` guard on every
// outbound URL, 20 MB payload cap (matches the zip upload limit).

import { env } from '../../config/env.js';
import {
  IMPORT_LIMITS, newStagedImport, storeStaging,
  type StagedImport, type StagedWorkflowEntry,
} from './importStaging.js';
import { extractLitegraph } from './extractLitegraph.js';
import { stageFromJson, stageFromZip } from './importZip.js';
import { extractDepsWithPluginResolution } from './extractDepsAsync.js';
import { deriveMediaType, extractWorkflowIo } from './metadata.js';
import { extractModelUrlsFromWorkflow } from './scanMarkdownNotes.js';
import { assertAllowed, normaliseGithubUrl } from './importRemote.urls.js';
import { autoResolveStagedImport } from './autoResolveModels.js';

const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedRemote {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
  /** Resolved URL actually fetched (post-normalisation). */
  resolvedUrl: string;
}

export interface RepoWalkFile {
  /** Path inside the repo (e.g. `workflows/foo.json`). */
  path: string;
  /** Raw download URL to pull the file bytes. */
  downloadUrl: string;
  size: number;
}

function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'comfyui-studio-import',
    Accept: 'application/vnd.github+json',
    ...extra,
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`payload too large: ${declared} > ${maxBytes}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(`payload too large: ${buf.byteLength} > ${maxBytes}`);
  }
  return buf;
}

export async function fetchRawFile(rawUrl: string): Promise<FetchedRemote> {
  const parsed = assertAllowed(rawUrl);
  const res = await fetchWithTimeout(parsed.toString(), githubHeaders({ Accept: '*/*' }));
  if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
  const bytes = await readBodyCapped(res, IMPORT_LIMITS.MAX_ZIP_BYTES);
  const contentType = res.headers.get('content-type') ?? '';
  const fileName = decodeURIComponent(parsed.pathname.split('/').pop() ?? 'download');
  return { bytes, contentType, fileName, resolvedUrl: parsed.toString() };
}

/**
 * Walk a repo via the GitHub contents API, collecting `.json` files at the
 * root and inside `/workflows/`. Kept deliberately shallow (two listings) so
 * the 60 req/h unauth budget isn't shredded on big monorepos.
 */
export async function walkRepoForWorkflows(
  owner: string, repo: string, ref: string, dir: string,
): Promise<RepoWalkFile[]> {
  const out: RepoWalkFile[] = [];
  const refQs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const basePath = dir ? `/${encodeURIComponent(dir)}` : '';
  const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${basePath}${refQs}`;
  await collectJsonFromListing(root, out);
  if (!dir) {
    const wf = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/workflows${refQs}`;
    try { await collectJsonFromListing(wf, out); }
    catch { /* workflows/ missing is fine */ }
  }
  return out;
}

async function collectJsonFromListing(apiUrl: string, into: RepoWalkFile[]): Promise<void> {
  assertAllowed(apiUrl);
  const res = await fetchWithTimeout(apiUrl, githubHeaders());
  if (!res.ok) {
    if (res.status === 404) return;
    throw new Error(`github listing ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return;
  for (const rawEntry of body) {
    const entry = rawEntry as { type?: unknown; name?: unknown; path?: unknown; download_url?: unknown; size?: unknown };
    if (entry.type !== 'file') continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!/\.json$/i.test(name)) continue;
    const downloadUrl = typeof entry.download_url === 'string' ? entry.download_url : '';
    if (!downloadUrl) continue;
    try { assertAllowed(downloadUrl); } catch { continue; }
    into.push({
      path: typeof entry.path === 'string' ? entry.path : name,
      downloadUrl,
      size: typeof entry.size === 'number' ? entry.size : 0,
    });
  }
}

function looksLikeZipByMeta(contentType: string, fileName: string): boolean {
  return /zip/i.test(contentType) || /\.zip$/i.test(fileName);
}
function looksLikeJsonByMeta(contentType: string, fileName: string): boolean {
  return /json/i.test(contentType) || /\.json$/i.test(fileName);
}

// `defaults` carries wrapper-extracted overrides — when the source JSON was a
// TemplateData wrapper, the author's explicit title/description beats the
// filename-derived fallback the staged row would otherwise use.
async function entryToWorkflow(
  name: string, workflow: Record<string, unknown>, size: number,
  defaults?: { defaultTitle?: string; defaultDescription?: string },
): Promise<StagedWorkflowEntry> {
  const deps = await extractDepsWithPluginResolution(workflow);
  const io = extractWorkflowIo(workflow);
  const base = name.split('/').pop() ?? name;
  const fallback = base.replace(/\.json$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported workflow';
  return {
    entryName: name, title: defaults?.defaultTitle ?? fallback,
    description: defaults?.defaultDescription,
    nodeCount: Array.isArray(workflow.nodes) ? (workflow.nodes as unknown[]).length : 0,
    models: deps.models, modelLoaderClasses: deps.modelLoaderClasses,
    modelUrls: extractModelUrlsFromWorkflow(workflow),
    plugins: deps.plugins,
    mediaType: deriveMediaType(io), jsonBytes: size, workflow,
  };
}

async function stageFromRawFile(rawUrl: string): Promise<StagedImport> {
  const fetched = await fetchRawFile(rawUrl);
  if (looksLikeZipByMeta(fetched.contentType, fetched.fileName)) {
    return stageFromZip(fetched.bytes, {
      source: 'upload', sourceUrl: fetched.resolvedUrl,
      defaultTitle: fetched.fileName.replace(/\.zip$/i, ''),
    });
  }
  if (!looksLikeJsonByMeta(fetched.contentType, fetched.fileName)) {
    throw new Error(`Unsupported content-type: ${fetched.contentType || 'unknown'}`);
  }
  const text = new TextDecoder('utf-8').decode(new Uint8Array(fetched.bytes));
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new Error(`File is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const extracted = extractLitegraph(parsed);
  if (!extracted) throw new Error('JSON is not a LiteGraph workflow or TemplateData wrapper.');
  return stageFromJson(extracted.workflow, {
    source: 'upload', sourceUrl: fetched.resolvedUrl,
    entryName: fetched.fileName,
    defaultTitle: fetched.fileName.replace(/\.json$/i, ''),
    ...extracted.defaults,
  });
}

async function stageFromRepoWalk(
  owner: string, repo: string, ref: string, dir: string,
): Promise<StagedImport> {
  const candidates = await walkRepoForWorkflows(owner, repo, ref, dir);
  if (candidates.length === 0) {
    throw new Error('No workflow JSON files found in the repository root or /workflows directory.');
  }
  const sourceUrl = ref
    ? `https://github.com/${owner}/${repo}/tree/${ref}${dir ? `/${dir}` : ''}`
    : `https://github.com/${owner}/${repo}`;
  const promises: Promise<StagedWorkflowEntry>[] = candidates.map((cand) => (async () => {
    const res = await fetchWithTimeout(cand.downloadUrl, githubHeaders({ Accept: '*/*' }));
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText} for ${cand.path}`);
    const bytes = await readBodyCapped(res, IMPORT_LIMITS.MAX_ZIP_BYTES);
    const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`File is not valid JSON: ${cand.path}`); }
    const extracted = extractLitegraph(parsed);
    if (!extracted) throw new Error(`${cand.path} is not a LiteGraph workflow or TemplateData wrapper.`);
    return entryToWorkflow(cand.path, extracted.workflow, text.length, extracted.defaults);
  })());
  const settled = await Promise.allSettled(promises);
  const workflows: StagedWorkflowEntry[] = [];
  const notes: string[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') workflows.push(r.value);
    else notes.push(`Skipped: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  }
  if (workflows.length === 0) throw new Error('All repository candidate files failed validation.');
  const staged = newStagedImport('upload', sourceUrl);
  staged.workflows = workflows;
  staged.notes = notes;
  staged.defaultTitle = `${owner}/${repo}`;
  await autoResolveStagedImport(staged);
  return storeStaging(staged);
}

/** Single entry-point for the GitHub import tab. */
export async function stageFromRemoteUrl(input: string): Promise<StagedImport> {
  const normalised = normaliseGithubUrl(input);
  if (normalised.kind === 'rawFile') return stageFromRawFile(normalised.rawUrl!);
  return stageFromRepoWalk(normalised.owner!, normalised.repo!, normalised.ref || '', normalised.dir || '');
}

/** Validate + stage a single workflow from a pasted JSON string. */
export async function stageFromPastedJson(
  text: string, opts: { title?: string } = {},
): Promise<StagedImport> {
  if (typeof text !== 'string') throw new Error('json must be a string');
  const byteLen = new TextEncoder().encode(text).byteLength;
  if (byteLen > IMPORT_LIMITS.MAX_ZIP_BYTES) {
    throw new Error(`payload too large: ${byteLen} > ${IMPORT_LIMITS.MAX_ZIP_BYTES}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new Error(`File is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const extracted = extractLitegraph(parsed);
  if (!extracted) throw new Error('JSON is not a LiteGraph workflow or TemplateData wrapper.');
  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : undefined;
  return stageFromJson(extracted.workflow, {
    source: 'upload', entryName: 'pasted-workflow.json', defaultTitle: title,
    ...extracted.defaults,
  });
}

export { normaliseGithubUrl } from './importRemote.urls.js';
