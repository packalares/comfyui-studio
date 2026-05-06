// Model-side helpers for `dependencyCheck.ts`. Walks `properties.models[]`
// entries on every workflow node, unions the canonical `extractDeps()`
// filename list, and resolves each filename to "installed?" via the launcher
// scan + `model_files` index + on-disk repo-directory probe. The split keeps
// the orchestrator under the file-size cap.

import fs from 'fs';
import path from 'path';
import * as catalog from '../catalog.js';
import { extractDepsWithPluginResolution } from './extractDepsAsync.js';
import { extractDeps } from './depExtract.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import { env } from '../../config/env.js';
import type {
  LauncherModelEntry,
  RequiredModelInfo,
} from '../../contracts/generation.contract.js';
import type { WorkflowNode } from '../../contracts/workflow.contract.js';

interface RepoEntryData {
  name: string;
  hfRepo: string;
  directory: string;
  description?: string;
}

export interface CollectedRequirements {
  required: Set<string>;
  templateDir: Map<string, string>;
  /** Whole-HF-repo entries declared on `properties.models` via `hfRepo` (no
   *  `url`); the whole repo is the artifact. Used for custom nodes whose
   *  weights are multi-file packages (IndexTTS2 etc.). */
  repoEntries: Map<string, RepoEntryData>;
}

// Walk every node for `properties.models[]` side effects: upsert catalog rows
// with the author's URL, build the per-filename `directory` map, collect
// whole-HF-repo entries. The required-filenames union is sourced from the
// canonical `extractDeps()` so this path shares the import path's walker.
export function collectRequirements(
  workflow: Record<string, unknown>,
  allNodes: WorkflowNode[],
  templateName: string,
): CollectedRequirements {
  const templateDir = new Map<string, string>();
  const repoEntries = new Map<string, RepoEntryData>();
  for (const node of allNodes) {
    const nodeTemplateModels = (node.properties as Record<string, unknown> | undefined)?.models;
    if (!Array.isArray(nodeTemplateModels)) continue;
    for (const raw of nodeTemplateModels as Array<Record<string, unknown>>) {
      const name = raw.name as string | undefined;
      const url = raw.url as string | undefined;
      const hfRepo = raw.hfRepo as string | undefined;
      const dir = raw.directory as string | undefined;
      if (!name) continue;
      if (dir) templateDir.set(name, dir);
      if (hfRepo && dir) {
        if (!repoEntries.has(name)) {
          repoEntries.set(name, {
            name, hfRepo, directory: dir,
            description: raw.description as string | undefined,
          });
        }
        continue;
      }
      if (url) {
        catalog.upsertModel({
          filename: name, name, type: dir || 'other',
          save_path: dir || 'checkpoints', url,
          description: raw.description as string | undefined,
          source: `template:${templateName}`,
        });
      }
    }
  }
  const required = new Set(extractDeps(workflow).models);
  return { required, templateDir, repoEntries };
}

export async function collectModelFolders(
  workflow: Record<string, unknown>,
): Promise<Record<string, string>> {
  try {
    const deps = await extractDepsWithPluginResolution(workflow);
    return deps.modelFolders;
  } catch {
    return {};
  }
}

export async function fetchInstalledModels(): Promise<LauncherModelEntry[]> {
  try {
    const models = await import('../models/models.service.js');
    const list = await models.scanAndRefresh();
    const out: LauncherModelEntry[] = [];
    for (const m of list) {
      const w = models.toWireEntry(m);
      if (!w.filename) continue;
      out.push({
        name: w.name || w.filename, type: w.type || 'other',
        filename: w.filename, url: w.url || '',
        size: w.size, fileSize: w.fileSize,
        installed: !!w.installed, save_path: w.save_path,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function installedNameSet(installedModels: LauncherModelEntry[]): Set<string> {
  const installedSet = new Set<string>();
  for (const m of installedModels) {
    if (m.installed) {
      installedSet.add(m.filename);
      installedSet.add(m.name);
    }
  }
  return installedSet;
}

export async function refreshStaleEntries(filenames: Set<string>): Promise<void> {
  const toRefresh = Array.from(filenames).filter(fn => {
    const entry = catalog.getModel(fn);
    return entry ? catalog.isSizeStale(entry) : false;
  });
  if (toRefresh.length > 0) {
    await catalog.refreshMany(toRefresh, { concurrency: 4 });
  }
}

function dirHasAnyFile(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir);
    return entries.some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

export function buildRequiredList(args: {
  requiredFilenames: Set<string>;
  templateDir: Map<string, string>;
  modelFolders: Record<string, string>;
  installedModels: LauncherModelEntry[];
  installedSet: Set<string>;
  repoEntries: Map<string, RepoEntryData>;
}): { required: RequiredModelInfo[]; missing: RequiredModelInfo[] } {
  const required: RequiredModelInfo[] = [];
  const missing: RequiredModelInfo[] = [];
  // Dedup by basename: the same file can be declared in `properties.models[]`
  // by basename AND referenced by widget value as `subfolder/filename`
  // (ReActor pattern). Collapse to one entry; the path-form hits later in
  // the loop just refine the directory hint and skip re-emitting.
  const seenBasenames = new Set<string>();
  for (const filename of args.requiredFilenames) {
    const basename = filename.includes('/')
      ? (filename.split('/').pop() ?? filename)
      : filename;
    if (seenBasenames.has(basename)) continue;
    seenBasenames.add(basename);
    const subPath = filename.includes('/')
      ? filename.slice(0, filename.lastIndexOf('/'))
      : '';
    const cat = catalog.getModel(basename) ?? catalog.getModel(filename);
    const scanEntry = args.installedModels.find(
      m => m.filename === basename || m.name === basename
        || m.filename === filename || m.name === filename,
    );
    const tooltipFolder = args.modelFolders[filename] ?? args.modelFolders[basename];
    const directory = args.templateDir.get(filename)
      || (tooltipFolder && subPath ? `${tooltipFolder}/${subPath}` : tooltipFolder)
      || cat?.save_path || scanEntry?.type || '';
    let isInstalled = args.installedSet.has(basename) || args.installedSet.has(filename);
    let diskSize: number | null = null;
    if (!isInstalled) {
      const hit = modelFiles.listByFilename(basename)[0]
        ?? (directory ? modelFiles.findByDirAndName(directory, basename) : null)
        ?? modelFiles.listByFilename(filename)[0]
        ?? null;
      if (hit && hit.status === 'complete') {
        isInstalled = true;
        diskSize = hit.size;
      }
    }
    const entry: RequiredModelInfo = {
      name: basename,
      url: cat?.url || '',
      directory,
      size: cat?.size_bytes || scanEntry?.fileSize || diskSize || undefined,
      size_pretty: cat?.size_pretty || undefined,
      installed: isInstalled,
      gated: cat?.gated,
      gated_message: cat?.gated_message,
    };
    required.push(entry);
    if (!isInstalled) missing.push(entry);
  }
  // Whole-repo entries: "installed" = target directory exists AND non-empty.
  // We don't know the file list, so non-empty dir is the practical signal.
  for (const entry of args.repoEntries.values()) {
    const absDir = path.resolve(env.COMFYUI_PATH, entry.directory);
    const installed = dirHasAnyFile(absDir);
    const info: RequiredModelInfo = {
      name: entry.name, url: '', hfRepo: entry.hfRepo,
      directory: entry.directory, installed,
    };
    required.push(info);
    if (!installed) missing.push(info);
  }
  return { required, missing };
}
