// Zip + single-JSON staging builders.
//
// Responsibility: turn an incoming payload (zip buffer or parsed workflow
// object) into a `StagedImport`, then hand off to `storeStaging`. Metadata
// extraction — model deps, plugin ids, io.inputs/outputs — happens here so
// the manifest returned to the frontend is complete on the first round-trip.

import JSZip from 'jszip';
import { extractDepsWithPluginResolution } from './extractDepsAsync.js';
import { extractWorkflowIo, deriveMediaType } from './metadata.js';
import { extractModelUrlsFromWorkflow } from './scanMarkdownNotes.js';
import { autoResolveStagedImport } from './autoResolveModels.js';
import { extractLitegraph } from './extractLitegraph.js';
import {
  newStagedImport,
  storeStaging,
  looksLikeLitegraph,
  entryNameIsSafe,
  IMPORT_LIMITS,
  type StagedImport,
  type StagedWorkflowEntry,
  type StagedImageEntry,
  type ImportSource,
} from './importStaging.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const NOTE_EXT_RE = /\.(md|txt)$/i;
const JSON_EXT_RE = /\.json$/i;

function countNodes(wf: Record<string, unknown>): number {
  const nodes = wf.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function titleFromEntryName(name: string): string {
  const base = name.split('/').pop() ?? name;
  const stripped = base.replace(/\.json$/i, '').replace(/[_-]+/g, ' ').trim();
  return stripped.length > 0 ? stripped : 'Imported workflow';
}

function mimeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

// `defaults` carries wrapper-extracted overrides — when the zip entry was a
// TemplateData wrapper, the author's explicit title/description beats the
// filename-derived fallback the staged row would otherwise use.
async function entryToWorkflow(
  name: string, workflow: Record<string, unknown>, size: number,
  defaults?: { defaultTitle?: string; defaultDescription?: string },
): Promise<StagedWorkflowEntry> {
  // Manager resolution is async — we fan out per workflow in `stageFromZip`
  // via `Promise.all` below. ComfyUI-offline degrades gracefully: the
  // resolver returns zero-match rows and staging still completes.
  const deps = await extractDepsWithPluginResolution(workflow);
  const io = extractWorkflowIo(workflow);
  return {
    entryName: name,
    title: defaults?.defaultTitle ?? titleFromEntryName(name),
    description: defaults?.defaultDescription,
    nodeCount: countNodes(workflow),
    models: deps.models,
    modelLoaderClasses: deps.modelLoaderClasses,
    modelUrls: extractModelUrlsFromWorkflow(workflow),
    plugins: deps.plugins,
    mediaType: deriveMediaType(io),
    jsonBytes: size,
    workflow,
  };
}

export interface StageFromZipOptions {
  source: ImportSource;
  sourceUrl?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultTags?: string[];
  defaultThumbnail?: string;
}

/** Walk the zip, collect workflows + images + notes. */
export async function stageFromZip(
  zipBuffer: ArrayBuffer | Uint8Array,
  opts: StageFromZipOptions,
): Promise<StagedImport> {
  const buf = zipBuffer instanceof Uint8Array ? zipBuffer : new Uint8Array(zipBuffer);
  if (buf.byteLength > IMPORT_LIMITS.MAX_ZIP_BYTES) {
    throw new Error(`zip exceeds maximum size (${IMPORT_LIMITS.MAX_ZIP_BYTES} bytes)`);
  }
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  if (names.length > IMPORT_LIMITS.MAX_ZIP_ENTRIES) {
    throw new Error(`zip has too many entries (${names.length} > ${IMPORT_LIMITS.MAX_ZIP_ENTRIES})`);
  }

  const workflowPromises: Promise<StagedWorkflowEntry>[] = [];
  const images: StagedImageEntry[] = [];
  const notes: string[] = [];

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!entryNameIsSafe(name)) continue;
    if (JSON_EXT_RE.test(name)) {
      const text = await entry.async('string');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      const extracted = extractLitegraph(parsed);
      if (!extracted) continue;
      workflowPromises.push(
        entryToWorkflow(name, extracted.workflow, text.length, extracted.defaults),
      );
    } else if (IMAGE_EXT_RE.test(name)) {
      const bytes = await entry.async('uint8array');
      images.push({ name: name.split('/').pop() ?? name, mimeType: mimeFor(name), bytes });
    } else if (NOTE_EXT_RE.test(name)) {
      try { notes.push(await entry.async('string')); } catch { /* ignore */ }
    }
  }
  const workflows: StagedWorkflowEntry[] = await Promise.all(workflowPromises);

  const staged = newStagedImport(opts.source, opts.sourceUrl);
  staged.workflows = workflows;
  staged.images = images;
  staged.notes = notes;
  staged.defaultTitle = opts.defaultTitle;
  staged.defaultDescription = opts.defaultDescription;
  staged.defaultTags = opts.defaultTags;
  staged.defaultThumbnail = opts.defaultThumbnail;
  // If a zip ships with exactly one workflow, let the sole entry's title be
  // the default title so the review UI lines up with single-JSON uploads.
  if (workflows.length === 1 && opts.defaultTitle) {
    workflows[0].title = opts.defaultTitle;
    workflows[0].description = opts.defaultDescription;
  }
  await autoResolveStagedImport(staged);
  return storeStaging(staged);
}

export interface StageFromJsonOptions {
  source: ImportSource;
  sourceUrl?: string;
  entryName?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultTags?: string[];
  defaultThumbnail?: string;
}

/** Stage a single JSON workflow (single-file upload or paste). */
export async function stageFromJson(
  workflow: Record<string, unknown>,
  opts: StageFromJsonOptions,
): Promise<StagedImport> {
  if (!looksLikeLitegraph(workflow)) {
    throw new Error('Workflow JSON has no top-level `nodes` array; not a LiteGraph document.');
  }
  const entryName = opts.entryName ?? 'workflow.json';
  const serialized = JSON.stringify(workflow);
  const entry = await entryToWorkflow(entryName, workflow, serialized.length);
  if (opts.defaultTitle) entry.title = opts.defaultTitle;
  if (opts.defaultDescription) entry.description = opts.defaultDescription;

  const staged = newStagedImport(opts.source, opts.sourceUrl);
  staged.workflows = [entry];
  staged.defaultTitle = opts.defaultTitle;
  staged.defaultDescription = opts.defaultDescription;
  staged.defaultTags = opts.defaultTags;
  staged.defaultThumbnail = opts.defaultThumbnail;
  await autoResolveStagedImport(staged);
  return storeStaging(staged);
}
