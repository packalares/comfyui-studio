// Discovery for HF-snapshot directories already on disk that the catalog
// doesn't know about. Walks the ComfyUI models root looking for dirs that
// match HF-style snapshots (config.json, sharded index, tokenizer.json, or
// .gitattributes from `huggingface-cli download` / `git clone`), then tries
// to recover the original HuggingFace repo id from on-disk hints.
//
// Detected entries are upserted into `catalog.json` with `hfRepo` set so the
// install button routes to `downloadHfRepo` (snapshot download) instead of
// the single-file walker.

import * as fs from 'fs';
import * as path from 'path';
import { getSharedModelHubRoot } from './installScan.js';
import { paths } from '../../config/paths.js';
import { upsertModel } from '../catalog/service.js';
import { logger } from '../../lib/logger.js';

const MAX_DEPTH = 5;

// Marker files that signal "this is an HF snapshot directory, not a loose
// model file dropped here by hand."
const SNAPSHOT_MARKERS = [
  'config.json',
  'model.safetensors.index.json',
  'model_index.json',
  'tokenizer.json',
  '.gitattributes',
];

// File we'd hand to the install-status detector as the "is the model on disk?"
// canary. First match wins. Sharded models prefer shard 1 since that's what
// `markInstalled` keys by once a download lands.
const REPRESENTATIVE_FILES = [
  'model-00001-of-00005.safetensors',
  'model-00001-of-00004.safetensors',
  'model-00001-of-00003.safetensors',
  'model-00001-of-00002.safetensors',
  'model.safetensors',
  'pytorch_model.bin',
  'diffusion_pytorch_model.safetensors',
  'diffusion_pytorch_model.bin',
];

export interface DiscoveredSnapshot {
  /** Absolute path on disk. */
  dir: string;
  /** Path relative to the models root — used as catalog `save_path`. */
  relDir: string;
  /** Best-effort HF repo id ("<owner>/<repo>"). Null if no hints available. */
  hfRepo: string | null;
  /** Filename used for install-status detection. */
  representativeFile: string | null;
  /** Where the hfRepo hint came from. Useful for debugging false positives. */
  hfRepoSource: 'config._name_or_path' | 'cache' | 'readme' | null;
}

/** Recursively walk `root`, capturing every dir that looks like an HF snapshot. */
async function walkForSnapshots(
  root: string,
  out: string[],
  depth = 0,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const hasMarker = SNAPSHOT_MARKERS.some((m) => fileNames.has(m));
  if (hasMarker) {
    out.push(root);
    // Don't recurse INTO a snapshot — its subfolders (e.g. text_encoder/) are
    // part of the same model, not nested snapshots.
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Skip hidden + cache dirs.
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    await walkForSnapshots(path.join(root, e.name), out, depth + 1);
  }
}

/** Try to extract HF repo id from various on-disk hints. */
async function detectHfRepo(
  dir: string,
): Promise<{ hfRepo: string | null; source: DiscoveredSnapshot['hfRepoSource'] }> {
  // 1) config.json `_name_or_path` is the most reliable (transformers convention).
  const configPath = path.join(dir, 'config.json');
  try {
    const raw = await fs.promises.readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const nameOrPath = String(cfg._name_or_path || '').trim();
    const matched = matchOwnerRepo(nameOrPath);
    if (matched) return { hfRepo: matched, source: 'config._name_or_path' };
  } catch { /* fall through */ }

  // 2) Old huggingface_hub cache sometimes leaves a `models--<owner>--<repo>`
  //    sibling. Look one level up.
  try {
    const parent = path.dirname(dir);
    const siblings = await fs.promises.readdir(parent);
    const me = path.basename(dir);
    const hubMatch = siblings.find((s) => s.startsWith('models--') && s.endsWith(`--${me}`));
    if (hubMatch) {
      const parts = hubMatch.replace(/^models--/, '').split('--');
      if (parts.length >= 2) return { hfRepo: parts.join('/'), source: 'cache' };
    }
  } catch { /* fall through */ }

  // 3) README.md often references the canonical HF page.
  try {
    const readme = await fs.promises.readFile(path.join(dir, 'README.md'), 'utf8');
    const m = readme.match(/huggingface\.co\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)/);
    if (m) return { hfRepo: m[1], source: 'readme' };
  } catch { /* fall through */ }

  return { hfRepo: null, source: null };
}

/** Strip non-owner-repo prefixes ("/root/data/repo/foo/bar" → "foo/bar"). */
function matchOwnerRepo(text: string): string | null {
  if (!text) return null;
  const m = text.match(/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)$/);
  if (!m) return null;
  // Reject "./../" remnants.
  if (m[1].startsWith('./') || m[1].startsWith('..')) return null;
  return m[1];
}

/** Pick the first existing file from REPRESENTATIVE_FILES, or the first .safetensors/.bin in the dir. */
async function pickRepresentativeFile(dir: string): Promise<string | null> {
  for (const candidate of REPRESENTATIVE_FILES) {
    try {
      await fs.promises.stat(path.join(dir, candidate));
      return candidate;
    } catch { /* keep looking */ }
  }
  try {
    const names = await fs.promises.readdir(dir);
    return names.find((n) => /\.(safetensors|bin|gguf|ckpt|pt|pth)$/i.test(n)) ?? null;
  } catch { return null; }
}

/** Public entry point: walk + classify + return findings. Does NOT mutate the catalog. */
export async function discoverHfSnapshotDirs(): Promise<DiscoveredSnapshot[]> {
  const roots: string[] = [];
  const hubRoot = getSharedModelHubRoot();
  if (hubRoot && fs.existsSync(hubRoot)) roots.push(hubRoot);
  if (paths.modelsDir && fs.existsSync(paths.modelsDir)) roots.push(paths.modelsDir);

  const found: DiscoveredSnapshot[] = [];
  for (const root of roots) {
    const dirs: string[] = [];
    await walkForSnapshots(root, dirs);
    for (const dir of dirs) {
      const { hfRepo, source } = await detectHfRepo(dir);
      const representativeFile = await pickRepresentativeFile(dir);
      found.push({
        dir,
        relDir: path.relative(root, dir),
        hfRepo,
        representativeFile,
        hfRepoSource: source,
      });
    }
  }
  return found;
}

/** Walk + classify + upsert into catalog. Returns counts for the caller. */
export async function discoverAndUpsert(): Promise<{
  scanned: number;
  upserted: number;
  skippedNoRepo: number;
  skippedNoFile: number;
  entries: Array<{ relDir: string; hfRepo: string; filename: string }>;
}> {
  const found = await discoverHfSnapshotDirs();
  let upserted = 0;
  let skippedNoRepo = 0;
  let skippedNoFile = 0;
  const entries: Array<{ relDir: string; hfRepo: string; filename: string }> = [];

  for (const f of found) {
    if (!f.hfRepo) { skippedNoRepo++; continue; }
    if (!f.representativeFile) { skippedNoFile++; continue; }
    upsertModel({
      filename: f.representativeFile,
      name: f.hfRepo,
      type: 'LLM',
      save_path: f.relDir,
      url: `https://huggingface.co/${f.hfRepo}/resolve/main/${f.representativeFile}`,
      reference: `https://huggingface.co/${f.hfRepo}`,
      description: `Multi-file HuggingFace snapshot — auto-discovered from on-disk dir ${f.relDir}. Install via downloadHfRepo (whole repo).`,
      source: 'auto-resolve:huggingface',
      hfRepo: f.hfRepo,
    });
    upserted++;
    entries.push({ relDir: f.relDir, hfRepo: f.hfRepo, filename: f.representativeFile });
  }

  logger.info('hf-repo discovery completed', {
    scanned: found.length, upserted, skippedNoRepo, skippedNoFile,
  });
  return { scanned: found.length, upserted, skippedNoRepo, skippedNoFile, entries };
}
