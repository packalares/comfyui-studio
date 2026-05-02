// Dependency check: given a template name, produce the list of every model
// the workflow will touch, whether each is already on disk, and (when known)
// a pretty size + gated flag for the install modal.
//
// Install detection order: launcher's `/api/models` scan (installed=true)
// first, then filesystem stat as a fallback (the launcher's catalog sometimes
// lags behind download-custom writes).

import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as catalog from '../services/catalog.js';
import * as templatesSvc from '../services/templates/index.js';
import { extractDepsWithPluginResolution } from '../services/templates/extractDepsAsync.js';
import { extractDeps } from '../services/templates/depExtract.js';
import {
  isPluginInstalled, getInstalledPluginKeys,
} from '../services/plugins/installedKeys.js';
import {
  canonicalize, dedupKey, normalizeRepoKey, repoBasename,
} from '../services/plugins/canonicalId.js';
import { findSubgraphDef } from '../services/workflow/proxyLabels.js';
import { collectAllWorkflowNodes } from '../services/workflow/index.js';
import * as modelFiles from '../lib/db/modelFiles.repo.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';
import type {
  LauncherModelEntry,
  RequiredItem,
  RequiredModelInfo,
  RequiredPluginInfo,
} from '../contracts/generation.contract.js';
import type { WorkflowNode } from '../contracts/workflow.contract.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

interface RepoEntryData {
  name: string;
  hfRepo: string;
  directory: string;
  description?: string;
}

interface CollectedRequirements {
  required: Set<string>;
  templateDir: Map<string, string>;
  /**
   * Whole-HF-repo entries declared directly on a node's `properties.models`
   * via the `hfRepo` field (no `url` — the whole repo is the artifact).
   * Used for custom nodes whose weights are multi-file packages
   * (IndexTTS2, etc.). Author puts these on the node in the workflow JSON
   * the same way they'd put single-file entries for standard loaders.
   */
  repoEntries: Map<string, RepoEntryData>;
}

// Walk every node for `properties.models[]` side effects: upsert catalog rows
// with the author's URL, build the per-filename `directory` map, and collect
// whole-HF-repo entries. The required-filenames union itself is sourced from
// the canonical `extractDeps()` so this route shares the import path's walker
// (LOADER_TYPES gate dropped, .onnx + .gguf supported, ^DownloadAndLoad
// self-managers skipped). One source of truth.
function collectRequirements(
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
      // Whole-HF-repo entry: no single `url`, just a repo id + target
      // directory. Used for custom nodes whose weights are multi-file
      // packages (IndexTTS2, etc.). Download path runs
      // `huggingface-cli download <hfRepo> --local-dir <directory>`.
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
          filename: name,
          name,
          type: dir || 'other',
          save_path: dir || 'checkpoints',
          url,
          description: raw.description as string | undefined,
          source: `template:${templateName}`,
        });
      }
    }
  }
  // Canonical filename list: union of properties.models[] names + widget
  // values from non-self-managing loaders. `extractDeps` is the same
  // function the import path runs, so behaviour is consistent across
  // import staging and runtime dep checks.
  const required = new Set(extractDeps(workflow).models);
  return { required, templateDir, repoEntries };
}

/**
 * Resolve `/object_info` tooltips for every loader class referenced by the
 * workflow's required filenames. The async wrapper of `extractDeps` already
 * does this and caches the underlying ComfyUI fetch — we just call it and
 * reuse the result. Returns an empty map when objectInfo is unreachable
 * (ComfyUI offline) or no loader matches; caller falls back to existing
 * heuristics.
 */
async function collectModelFolders(
  workflow: Record<string, unknown>,
): Promise<Record<string, string>> {
  try {
    const deps = await extractDepsWithPluginResolution(workflow);
    return deps.modelFolders;
  } catch {
    return {};
  }
}

async function fetchInstalledModels(): Promise<LauncherModelEntry[]> {
  try {
    const models = await import('../services/models/models.service.js');
    const list = await models.scanAndRefresh();
    const out: LauncherModelEntry[] = [];
    for (const m of list) {
      const w = models.toWireEntry(m);
      if (!w.filename) continue;
      out.push({
        name: w.name || w.filename,
        type: w.type || 'other',
        filename: w.filename,
        url: w.url || '',
        size: w.size,
        fileSize: w.fileSize,
        installed: !!w.installed,
        save_path: w.save_path,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function buildRequiredList(
  requiredFilenames: Set<string>,
  templateDir: Map<string, string>,
  modelFolders: Record<string, string>,
  installedModels: LauncherModelEntry[],
  installedSet: Set<string>,
  repoEntries: Map<string, RepoEntryData>,
): { required: RequiredModelInfo[]; missing: RequiredModelInfo[] } {
  const required: RequiredModelInfo[] = [];
  const missing: RequiredModelInfo[] = [];
  // Dedup by basename: the same file can be declared in `properties.models[]`
  // by basename AND referenced by a widget value as `subfolder/filename`
  // (ReActor pattern). Collapse to one entry; the path-form hits later in
  // the loop just refine the directory hint and skip re-emitting.
  const seenBasenames = new Set<string>();

  for (const filename of requiredFilenames) {
    // Some loaders use a path-with-subfolder convention in their widget
    // value (e.g. ReActor's `ReActorMaskHelper` ships `bbox/face_yolov8m.pt`)
    // — the literal string includes the subfolder relative to the loader's
    // root. Strip the subfolder for index lookups (the index is keyed by
    // basename) but preserve it for the directory hint downstream.
    const basename = filename.includes('/')
      ? (filename.split('/').pop() ?? filename)
      : filename;
    if (seenBasenames.has(basename)) continue;
    seenBasenames.add(basename);
    const subPath = filename.includes('/')
      ? filename.slice(0, filename.lastIndexOf('/'))
      : '';
    const cat = catalog.getModel(basename) ?? catalog.getModel(filename);
    const scanEntry = installedModels.find(
      m => m.filename === basename || m.name === basename
        || m.filename === filename || m.name === filename,
    );
    // Directory priority: author's properties.models[].directory >
    // /object_info tooltip > catalog.save_path > disk-scan inferred type.
    // When the widget carried a subfolder, append it onto the tooltip
    // folder (`ultralytics` + `bbox` -> `ultralytics/bbox`) so the install
    // path matches the loader's actual lookup root.
    const tooltipFolder = modelFolders[filename] ?? modelFolders[basename];
    const directory = templateDir.get(filename)
      || (tooltipFolder && subPath ? `${tooltipFolder}/${subPath}` : tooltipFolder)
      || cat?.save_path
      || scanEntry?.type
      || '';

    let isInstalled = installedSet.has(basename) || installedSet.has(filename);
    let diskSize: number | null = null;
    if (!isInstalled) {
      // SQLite-backed index lookup: try the basename first (the index keys
      // on bare filenames). Fall back to the directory-narrowed lookup
      // when both forms are known.
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
      // Display the bare basename so the modal matches what the Models
      // page shows; the subfolder lives in `directory`.
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

  // Whole-repo entries: "installed" = target directory exists AND is
  // non-empty. We don't know the exact file list, so a non-empty dir is
  // the practical readiness signal.
  for (const entry of repoEntries.values()) {
    // `directory` on the entry is relative to ComfyUI root. `env.COMFYUI_PATH`
    // points there; `modelsDir` is `<comfyRoot>/models`, so we resolve from
    // COMFYUI_PATH directly instead of a `../` trick that falls apart when
    // modelsDir isn't exactly that sub-tree.
    const absDir = path.resolve(env.COMFYUI_PATH, entry.directory);
    const installed = dirHasAnyFile(absDir);
    const info: RequiredModelInfo = {
      name: entry.name,
      url: '',
      hfRepo: entry.hfRepo,
      directory: entry.directory,
      installed,
    };
    required.push(info);
    if (!installed) missing.push(info);
  }

  return { required, missing };
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

async function fetchTemplateWorkflow(
  templateName: string,
): Promise<Record<string, unknown> | null> {
  try {
    // User-imported workflows live on our disk; only hit ComfyUI for the rest.
    if (templatesSvc.isUserWorkflow(templateName)) {
      return templatesSvc.getUserWorkflowJson(templateName);
    }
    const wfRes = await fetch(
      `${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`,
    );
    if (!wfRes.ok) return null;
    const wfData = await wfRes.json();
    if (!wfData || typeof wfData !== 'object') return null;
    return wfData as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function refreshStaleEntries(filenames: Set<string>): Promise<void> {
  const toRefresh = Array.from(filenames).filter(fn => {
    const entry = catalog.getModel(fn);
    return entry ? catalog.isSizeStale(entry) : false;
  });
  if (toRefresh.length > 0) {
    await catalog.refreshMany(toRefresh, { concurrency: 4 });
  }
}

function installedNameSet(installedModels: LauncherModelEntry[]): Set<string> {
  const installedSet = new Set<string>();
  for (const m of installedModels) {
    if (m.installed) {
      installedSet.add(m.filename);
      installedSet.add(m.name);
    }
  }
  return installedSet;
}

// `repoMatchKey` and `repoBasename` re-exported from canonicalId for
// readability — the legacy local copies are gone.
const repoMatchKey = normalizeRepoKey;

interface ClassTypeContext {
  /** Parent subgraph display name, or null when at top level. */
  subgraphName: string | null;
  /** Normalised aux_id / cnr_id values harvested from any node carrying
   *  this class_type, useful for resolving the owning plugin when the
   *  Manager mapping API is unreachable. */
  auxKeys: Set<string>;
}

function harvestAuxKeys(node: Record<string, unknown>, into: Set<string>): void {
  const props = node.properties as Record<string, unknown> | undefined;
  if (!props) return;
  for (const fld of ['aux_id', 'cnr_id']) {
    const v = props[fld];
    if (typeof v === 'string' && v.length > 0) into.add(repoMatchKey(v));
  }
}

/**
 * Walk the workflow once and record per-class_type context: the parent
 * subgraph name AND any `aux_id`/`cnr_id` values found on nodes carrying
 * that class_type. The aux keys are the fallback when Manager's class_type
 * resolver is offline — they tell us which plugin owns each unresolved
 * class.
 *
 * Top-level nodes get `null` for `subgraphName`. Subgraph wrappers
 * themselves are NOT recorded (their `type` is a UUID, not a class).
 */
function collectClassTypeContexts(
  workflow: Record<string, unknown>,
): Map<string, ClassTypeContext> {
  const out = new Map<string, ClassTypeContext>();
  const ensure = (t: string, sg: string | null): ClassTypeContext => {
    let ctx = out.get(t);
    if (!ctx) {
      ctx = { subgraphName: sg, auxKeys: new Set() };
      out.set(t, ctx);
    } else if (ctx.subgraphName == null && sg != null) {
      ctx.subgraphName = sg;
    }
    return ctx;
  };
  const topNodes = (workflow.nodes as Array<Record<string, unknown>> | undefined) || [];
  for (const n of topNodes) {
    const t = (n.type as string | undefined) || (n.class_type as string | undefined);
    if (!t) continue;
    harvestAuxKeys(n, ensure(t, null).auxKeys);
  }
  for (const n of topNodes) {
    const props = n.properties as Record<string, unknown> | undefined;
    if (!props?.proxyWidgets && !n.subgraph) continue;
    const sg = findSubgraphDef(n, workflow);
    if (!sg) continue;
    const sgName = (sg.name as string | undefined) || (n.title as string | undefined) || null;
    const inner = (sg.nodes as Array<Record<string, unknown>> | undefined) || [];
    for (const ni of inner) {
      const t = (ni.type as string | undefined) || (ni.class_type as string | undefined);
      if (!t) continue;
      harvestAuxKeys(ni, ensure(t, sgName).auxKeys);
    }
  }
  return out;
}

/**
 * Build the missing-plugin entry list. For each class_type the workflow
 * uses, look up its candidate plugin repos via Manager, then check whether
 * any are installed. Class types whose repos are all not-installed (or
 * have no Manager match at all) become missing-plugin entries.
 *
 * Built-in `comfy-core` matches are filtered out — those are ComfyUI's
 * own nodes, never installable as plugins.
 */
async function buildPluginRequirementList(
  workflow: Record<string, unknown>,
): Promise<{ required: RequiredPluginInfo[]; missing: RequiredPluginInfo[] }> {
  const contexts = collectClassTypeContexts(workflow);
  const resolved = await extractDepsWithPluginResolution(workflow);
  // Pre-warm the canonical-id cache for every aux/cnr id we'll touch so
  // the dedup-by-canonical loop reads from cache.
  const auxBag = new Set<string>();
  for (const r of resolved.plugins) for (const m of r.matches) auxBag.add(m.repo);
  for (const ctx of contexts.values()) for (const k of ctx.auxKeys) auxBag.add(k);
  await Promise.all(Array.from(auxBag).map((r) => canonicalize(r)));
  const installedKeys = getInstalledPluginKeys();

  const required: RequiredPluginInfo[] = [];
  const missing: RequiredPluginInfo[] = [];
  // `extractDepsWithPluginResolution` mixes two row shapes: real Manager-
  // resolved class_types AND aux-only synthetic entries where `classType`
  // equals the repo key (e.g. `kijai/comfyui-wananimatepreprocess`). The
  // synthetics are useful as fallback REPO HINTS but render as noise in the
  // missing list — the user already sees the real class_type rows. We drop
  // them after using their repos to fill in real rows that the Manager left
  // empty.
  const isSyntheticAuxRow = (classType: string, matches: typeof resolved.plugins[number]['matches']): boolean => {
    if (matches.length !== 1) return false;
    return repoMatchKey(matches[0].repo) === repoMatchKey(classType);
  };
  // Canonical-keyed map of synthetic aux rows. Two rows pointing at the
  // same plugin via different identifier forms (cnr_id + aux_id) collapse
  // here. We prefer the row with a slash (owner/repo form) over a bare
  // cnr_id when both exist for the same plugin — the slashed form is the
  // valid GitHub URL the install button can use.
  const auxByCanonical = new Map<string, { repo: string; title: string; cnr_id?: string }>();
  for (const r of resolved.plugins) {
    if (!isSyntheticAuxRow(r.classType, r.matches)) continue;
    const m = r.matches[0];
    const key = repoMatchKey(m.repo);
    const dkey = dedupKey(key);
    const existing = auxByCanonical.get(dkey);
    if (!existing) {
      auxByCanonical.set(dkey, { repo: key, title: m.title, cnr_id: m.cnr_id });
    } else if (key.includes('/') && !existing.repo.includes('/')) {
      // Promote the owner/repo form over the bare cnr_id.
      auxByCanonical.set(dkey, { repo: key, title: m.title, cnr_id: m.cnr_id });
    }
  }

  const isBuiltinKey = (k: string): boolean =>
    k === 'comfy-core' || k === 'comfyui' || k === 'comfyanonymous/comfyui';

  for (const r of resolved.plugins) {
    if (isSyntheticAuxRow(r.classType, r.matches)) continue;

    // Filter `comfy-core` / `comfyui` builtin matches; remaining matches
    // are real plugin candidates.
    let realMatches = r.matches.filter((m) => !isBuiltinKey(repoMatchKey(m.repo)));
    // Manager said this class belongs to a builtin → it's ComfyUI core,
    // never an installable plugin. Skip.
    if (r.matches.length > 0 && realMatches.length === 0) continue;

    // Manager-empty class_type? Try to fill from aux_ids harvested off the
    // workflow nodes that carry this class_type. Filter builtin aux keys
    // out FIRST — `cnr_id: 'comfy-core'` is the explicit author signal that
    // the node is core ComfyUI, not a plugin requirement.
    const ctx = contexts.get(r.classType);
    const auxKeysReal = ctx
      ? Array.from(ctx.auxKeys).filter((k) => !isBuiltinKey(k))
      : [];
    if (realMatches.length === 0 && auxKeysReal.length > 0) {
      for (const auxKey of auxKeysReal) {
        const dkey = dedupKey(auxKey);
        const hit = auxByCanonical.get(dkey);
        if (hit) realMatches = [{ repo: hit.repo, title: hit.title, cnr_id: hit.cnr_id }];
        if (realMatches.length > 0) break;
      }
    }

    // Conservative skip: when neither Manager nor aux_id points at a real
    // plugin, we have zero evidence the class needs one. Could be a core
    // node Manager hasn't catalogued, or a custom node with no metadata.
    // Either way, NOT showing a false-positive missing-plugin entry beats
    // surfacing every unresolved class. Manager going offline is the most
    // common cause; this rule degrades gracefully.
    if (realMatches.length === 0
        && (!ctx || ctx.auxKeys.size === 0
            || Array.from(ctx.auxKeys).every(isBuiltinKey))) {
      continue;
    }

    const isInstalled = realMatches.length > 0
      && realMatches.every((m) => isPluginInstalled(m.repo, installedKeys));
    const subgraphName = ctx?.subgraphName ?? null;
    const entry: RequiredPluginInfo = {
      kind: 'plugin',
      classType: r.classType,
      subgraphName,
      repos: realMatches.map((m) => ({
        repo: repoMatchKey(m.repo),
        title: m.title,
        cnr_id: m.cnr_id,
      })),
      installed: isInstalled,
    };
    required.push(entry);
    if (!isInstalled) missing.push(entry);
  }

  return { required, missing };
}

router.post('/check-dependencies', async (req: Request, res: Response) => {
  try {
    const { templateName } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    const workflow = await fetchTemplateWorkflow(templateName);
    if (!workflow) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }
    const allNodes = collectAllWorkflowNodes(workflow);
    if (allNodes.length === 0) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }

    // Seed catalog (no-op after first call).
    await catalog.seedFromComfyUI();

    const { required: requiredFilenames, templateDir, repoEntries } =
      collectRequirements(workflow, allNodes, templateName);

    await refreshStaleEntries(requiredFilenames);

    const installedModels = await fetchInstalledModels();
    const installedSet = installedNameSet(installedModels);
    const modelFolders = await collectModelFolders(workflow);

    const { required: modelsReq, missing: modelsMissing } = buildRequiredList(
      requiredFilenames,
      templateDir,
      modelFolders,
      installedModels,
      installedSet,
      repoEntries,
    );
    // Stamp the `kind` discriminator so the UI's union type can route models
    // vs plugins to the right renderer in a single `missing[]` list.
    const stampedModelsReq: RequiredModelInfo[] =
      modelsReq.map((m) => ({ kind: 'model', ...m }));
    const stampedModelsMissing: RequiredModelInfo[] =
      modelsMissing.map((m) => ({ kind: 'model', ...m }));

    const { required: pluginsReq, missing: pluginsMissing } =
      await buildPluginRequirementList(workflow);

    const required: RequiredItem[] = [...stampedModelsReq, ...pluginsReq];
    const missing: RequiredItem[] = [...stampedModelsMissing, ...pluginsMissing];

    res.json({ ready: missing.length === 0, required, missing });
  } catch (err) {
    sendError(res, err, 500, 'Dependency check failed');
  }
});

export default router;
