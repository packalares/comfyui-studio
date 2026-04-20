// Dependency check: given a template name, produce the list of every model
// the workflow will touch, whether each is already on disk, and (when known)
// a pretty size + gated flag for the install modal.
//
// Install detection order: launcher's `/api/models` scan (installed=true)
// first, then filesystem stat as a fallback (the launcher's catalog sometimes
// lags behind download-custom writes).

import { Router, type Request, type Response } from 'express';
import * as catalog from '../services/catalog.js';
import { collectAllWorkflowNodes, LOADER_TYPES } from '../services/workflow/index.js';
import { statModelOnDisk } from '../lib/fs.js';
import { paths } from '../config/paths.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';
import type {
  LauncherModelEntry,
  RequiredModelInfo,
} from '../contracts/generation.contract.js';
import type { WorkflowNode } from '../contracts/workflow.contract.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

interface CollectedRequirements {
  required: Set<string>;
  templateDir: Map<string, string>;
}

// Walk every node; upsert each declared `properties.models[]` entry into our
// catalog (template URL wins), then record as required. Fallback: for loader
// nodes with a `widgets_values` filename but no `properties.models`, look the
// filename up in the existing catalog (seeded from ComfyUI) to still discover
// a URL.
function collectRequirements(
  allNodes: WorkflowNode[],
  templateName: string,
): CollectedRequirements {
  const required = new Set<string>();
  // Per-filename directory as declared by the template itself. Wins over
  // cat.save_path when we build the RequiredModelInfo response so the launcher
  // saves to exactly where the template's widget_values expects to find it.
  const templateDir = new Map<string, string>();

  for (const node of allNodes) {
    const nodeTemplateModels = (node.properties as Record<string, unknown> | undefined)?.models;
    if (Array.isArray(nodeTemplateModels)) {
      for (const raw of nodeTemplateModels as Array<Record<string, unknown>>) {
        const name = raw.name as string | undefined;
        const url = raw.url as string | undefined;
        const dir = raw.directory as string | undefined;
        if (!name) continue;
        if (dir) templateDir.set(name, dir);
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
        required.add(name);
      }
    }

    const nodeType = (node.type as string | undefined)
      || (node.class_type as string | undefined)
      || '';
    if (LOADER_TYPES.has(nodeType) && Array.isArray(node.widgets_values)) {
      for (const val of node.widgets_values) {
        if (typeof val !== 'string') continue;
        if (!/\.(safetensors|pth|ckpt|pt|bin)$/i.test(val)) continue;
        required.add(val);
      }
    }
  }
  return { required, templateDir };
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
  installedModels: LauncherModelEntry[],
  installedSet: Set<string>,
): { required: RequiredModelInfo[]; missing: RequiredModelInfo[] } {
  const modelsDir = paths.modelsDir;
  const required: RequiredModelInfo[] = [];
  const missing: RequiredModelInfo[] = [];

  for (const filename of requiredFilenames) {
    const cat = catalog.getModel(filename);
    const scanEntry = installedModels.find(
      m => m.filename === filename || m.name === filename,
    );
    const directory = templateDir.get(filename)
      || cat?.save_path
      || scanEntry?.type
      || '';

    let isInstalled = installedSet.has(filename);
    let diskSize: number | null = null;
    if (!isInstalled) {
      diskSize = statModelOnDisk(modelsDir, directory, filename);
      if (diskSize !== null) isInstalled = true;
    }

    const entry: RequiredModelInfo = {
      name: filename,
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

  return { required, missing };
}

async function fetchTemplateNodes(templateName: string): Promise<WorkflowNode[]> {
  try {
    const wfRes = await fetch(
      `${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`,
    );
    if (!wfRes.ok) return [];
    const wfData = await wfRes.json();
    if (!wfData || typeof wfData !== 'object') return [];
    return collectAllWorkflowNodes(wfData as Record<string, unknown>);
  } catch {
    return [];
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

router.post('/check-dependencies', async (req: Request, res: Response) => {
  try {
    const { templateName } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    const allNodes = await fetchTemplateNodes(templateName);
    if (allNodes.length === 0) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }

    // Seed catalog (no-op after first call).
    await catalog.seedFromComfyUI();

    const { required: requiredFilenames, templateDir } =
      collectRequirements(allNodes, templateName);
    if (requiredFilenames.size === 0) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }

    await refreshStaleEntries(requiredFilenames);

    const installedModels = await fetchInstalledModels();
    const installedSet = installedNameSet(installedModels);

    const { required, missing } = buildRequiredList(
      requiredFilenames,
      templateDir,
      installedModels,
      installedSet,
    );
    res.json({ ready: missing.length === 0, required, missing });
  } catch (err) {
    sendError(res, err, 500, 'Dependency check failed');
  }
});

export default router;
