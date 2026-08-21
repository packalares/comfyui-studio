// Capability-pack installer/uninstaller. Mirrors `services/plugins/install.ts`:
// install is fire-and-forget — the caller gets a taskId and polls
// `getInstallProgress(taskId)` (in-memory, dropped ~30s after completion).
// Every subprocess call flows through `lib/exec.run` (argv only, no shell).

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as packsRepo from '../../lib/db/packs.repo.js';
import * as packModelsRepo from '../../lib/db/packModels.repo.js';
import {
  getPack,
  getPackModel,
  venvPythonBin,
  type PackDefinition,
  type PackId,
  type PackModelDef,
  type VenvComponent,
} from './registry.js';
import { effectiveDest, effectiveRepo, isModelSelected } from './settings.js';
import { looksDownloaded } from './modelPaths.js';

// System interpreter used ONLY to create venvs (`python3 -m venv ...`) and to
// download models via `huggingface_hub` (a comfy-provided dep, no pack-owned
// pin conflicts). Every pack DEPENDENCY install runs through a component's
// own venv interpreter instead — see `ensureVenvComponent` below.
function python(): string {
  return env.PYTHON_PATH || 'python3';
}

const PIP_INSTALL_TIMEOUT_MS = 20 * 60 * 1000; // packs pull in heavier deps than a single plugin
const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const VENV_CREATE_TIMEOUT_MS = 3 * 60 * 1000;

// ---- In-memory progress (mirrors services/plugins/history.ts's Progress section) ----

export type PackTaskType = 'install' | 'uninstall' | 'model-download';

export interface PackTaskProgress {
  taskId: string;
  packId: string;
  type: PackTaskType;
  progress: number;
  completed: boolean;
  message?: string;
  logs: string[];
}

const tasks = new Map<string, PackTaskProgress>();

// WS broadcast hub — mirrors `services/ace/broadcaster.ts` / `services/chat/
// broadcaster.ts`'s setter pattern. Wired once at boot
// (`setPackBroadcaster(broadcast)` in `index.ts`). Every task mutation below
// pushes the full `PackTaskProgress` as `{type:'pack:progress', data}` so
// `Packs.tsx` gets live updates instead of polling
// `GET /packs/progress/:taskId` on a fixed interval.
let broadcaster: ((message: object) => void) | null = null;

export function setPackBroadcaster(fn: ((message: object) => void) | null): void {
  broadcaster = fn;
}

function broadcastTask(t: PackTaskProgress): void {
  if (broadcaster) broadcaster({ type: 'pack:progress', data: t });
}

function createTask(taskId: string, packId: string, type: PackTaskType): void {
  const t: PackTaskProgress = { taskId, packId, type, progress: 0, completed: false, logs: [] };
  tasks.set(taskId, t);
  broadcastTask(t);
}

function addLog(taskId: string, message: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.logs.push(`[${new Date().toLocaleString()}] ${message}`);
  broadcastTask(t);
}

function updateProgress(taskId: string, progress: number, message?: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.progress = progress;
  if (message !== undefined) t.message = message;
  broadcastTask(t);
}

function completeTask(taskId: string, success: boolean, message?: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.completed = true;
  t.progress = success ? 100 : 0;
  if (message !== undefined) t.message = message;
  broadcastTask(t);
  // Grace window keeps the final state pollable briefly; `unref` so the
  // timer never blocks process exit.
  setTimeout(() => tasks.delete(taskId), 30_000).unref();
}

export function getInstallProgress(taskId: string): PackTaskProgress | null {
  return tasks.get(taskId) ?? null;
}

/** Every task currently in-flight (or within its post-completion grace
 *  window) — the mount-time reconciliation path for `Packs.tsx`: a page
 *  refresh loses the client-side `packId -> taskId` map (it only ever lived
 *  in React state), but this in-memory `tasks` Map is exactly what the WS
 *  broadcasts above already reflect, so listing it is enough to resume
 *  tracking an in-flight install/uninstall after a reload. */
export function listActiveTasks(): PackTaskProgress[] {
  return [...tasks.values()];
}

type LogFn = (message: string) => void;

function makeLog(taskId: string): LogFn {
  return (msg: string) => {
    addLog(taskId, msg);
    logger.info(`[pack install ${taskId}] ${msg}`);
  };
}

// ---- Install steps ----

/**
 * `<venvPython> -m pip install <pkgs>` — installed into the given venv's own
 * site-packages, never any shared site. `PIP_USER=0` neutralises the
 * image-wide `PIP_USER=1` Dockerfile default: inside a virtualenv a
 * `--user` install is illegal ("User site-packages are not visible in this
 * virtualenv"), and pip reads that env var even though we never pass the
 * `--user` flag ourselves.
 */
async function pipInstallInVenv(venvPython: string, pkgs: string[], log: LogFn): Promise<void> {
  if (pkgs.length === 0) return;
  const args = ['-m', 'pip', 'install', ...pkgs];
  log(`Executing: ${venvPython} ${args.join(' ')}`);
  const r = await run(venvPython, args, {
    timeoutMs: PIP_INSTALL_TIMEOUT_MS,
    env: { PIP_USER: '0' },
  });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`pip install failed (code=${r.code})`);
}

/**
 * Download one `{repo, dest}` model via `huggingface_hub.snapshot_download`,
 * shelled out to python -c (argv-only — the script is a single argv element,
 * never concatenated into a shell string). Mirrors the same primitive
 * ace-step-ui's own Dockerfile uses for its whisper-large-v3 prewarm.
 *
 * `subfolder` (see `PackModelDef.repoSubfolder`) handles a model that's only
 * one subfolder of a larger combined repo (ACE-Step's 5Hz-LM 1.7B, which has
 * no standalone repo of its own — only a subfolder of `ACE-Step/Ace-Step1.5`,
 * a ~10 GB bundle covering several OTHER models this pack already downloads
 * separately). `local_dir` is pointed at `dest`'s PARENT with an
 * `allow_patterns` filter scoped to just that subfolder, rather than at
 * `dest` itself — `snapshot_download` preserves the repo's own subfolder
 * structure under `local_dir`, so `local_dir=<dest's parent>` naturally
 * produces `<dest's parent>/<subfolder>/...` == `dest`, without pulling
 * every other top-level folder in the bundle.
 */
async function downloadModel(spec: { repo: string; dest: string; subfolder?: string }, log: LogFn): Promise<void> {
  fs.mkdirSync(spec.dest, { recursive: true, mode: 0o755 });
  const localDir = spec.subfolder ? path.dirname(spec.dest) : spec.dest;
  const kwargs = [
    `repo_id=${JSON.stringify(spec.repo)}`,
    `local_dir=${JSON.stringify(localDir)}`,
  ];
  if (spec.subfolder) {
    kwargs.push(`allow_patterns=${JSON.stringify([`${spec.subfolder}/*`, `${spec.subfolder}/**/*`])}`);
  }
  const code = [
    'from huggingface_hub import snapshot_download',
    `snapshot_download(${kwargs.join(', ')})`,
  ].join('\n');
  log(`Downloading ${spec.repo}${spec.subfolder ? `/${spec.subfolder}` : ''} -> ${spec.dest}`);
  const r = await run(python(), ['-c', code], { timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS });
  if (r.stdout) log(`download stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`download stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`model download failed for ${spec.repo} (code=${r.code})`);
}

/** Best-effort recursive directory size in bytes — `pack_models.size_bytes`
 *  is UI display only, so a failure here (permissions, races with an
 *  in-progress download) just leaves it `null` rather than failing the
 *  whole download. Depth-bounded like `folderRegistry.ts`'s own disk walk. */
function dirSizeBestEffort(dir: string, depth = 0): number | null {
  if (depth > 8) return 0;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirSizeBestEffort(full, depth + 1) ?? 0;
    } else if (e.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch { /* file vanished mid-walk — ignore */ }
    }
  }
  return total;
}

/**
 * Download (or skip, if already present at the resolved destination — see
 * `looksDownloaded`) one pack model, recording state transitions into
 * `pack_models` as it goes. Shared by the full pack-install loop
 * (`runInstall`) and the single-model download route
 * (`downloadPackModel`/`runModelDownload`) so both paths behave identically.
 */
async function downloadPackModel(packId: PackId, model: PackModelDef, log: LogFn): Promise<void> {
  const repo = effectiveRepo(packId, model.id, model.repo);
  const dest = effectiveDest(packId, model.id, model.kind, repo, model.repoSubfolder);
  if (looksDownloaded(dest)) {
    log(`${model.label}: already present at ${dest} — skipping download`);
    packModelsRepo.setState(packId, model.id, 'downloaded', { dest, downloadedAt: Date.now() });
    return;
  }
  packModelsRepo.setState(packId, model.id, 'downloading', { dest });
  try {
    await downloadModel({ repo, dest, subfolder: model.repoSubfolder }, log);
    const sizeBytes = dirSizeBestEffort(dest);
    packModelsRepo.setState(packId, model.id, 'downloaded', { dest, sizeBytes, downloadedAt: Date.now() });
  } catch (err) {
    packModelsRepo.setState(packId, model.id, 'failed', { dest });
    throw err;
  }
}

/**
 * Shallow-clone `repoUrl` into `cloneDir` if it isn't already a checkout.
 * Idempotent — a pre-existing `.git` dir (from an earlier install, or a
 * volume that survived a pod restart) short-circuits the clone entirely so
 * re-installs don't re-fetch multi-hundred-MB repos every boot.
 */
async function cloneGitRepo(repoUrl: string, cloneDir: string, log: LogFn): Promise<void> {
  if (fs.existsSync(path.join(cloneDir, '.git'))) {
    log(`Clone already present at ${cloneDir} — skipping git clone`);
    return;
  }
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true, mode: 0o755 });
  // Clean up a partial/broken clone from an earlier failed attempt (present
  // but no .git — e.g. interrupted mkdir) before retrying.
  if (fs.existsSync(cloneDir)) {
    await fs.promises.rm(cloneDir, { recursive: true, force: true });
  }
  const args = ['clone', '--depth', '1', repoUrl, cloneDir];
  log(`Executing: git ${args.join(' ')}`);
  const r = await run('git', args, { timeoutMs: GIT_CLONE_TIMEOUT_MS });
  if (r.stdout) log(`git stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`git stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`git clone failed (code=${r.code})`);
}

/**
 * `<venvPython> -m pip install -r requirements.txt` from inside a cloned
 * repo that has no real packaging metadata (no setup.py/pyproject.toml —
 * just a requirements.txt at the root, ai-toolkit's actual shape). `cwd:
 * cloneDir` matters: some requirements.txt files reference sibling files via
 * relative `-r other.txt` includes (ai-toolkit's does —
 * `requirements_base.txt`). Installed into the OWNING component's venv, not
 * any shared site — same `PIP_USER=0` neutralisation as `pipInstallInVenv`.
 */
async function pipInstallRequirements(venvPython: string, cloneDir: string, log: LogFn): Promise<void> {
  const requirementsPath = path.join(cloneDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements.txt not found in clone: ${requirementsPath}`);
  }
  const args = ['-m', 'pip', 'install', '-r', requirementsPath];
  log(`Executing: ${venvPython} ${args.join(' ')} (cwd=${cloneDir})`);
  const r = await run(venvPython, args, {
    cwd: cloneDir,
    timeoutMs: PIP_INSTALL_TIMEOUT_MS,
    env: { PIP_USER: '0' },
  });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`pip install -r requirements.txt failed (code=${r.code})`);
}

/**
 * Provision one `VenvComponent`: `python3 -m venv --system-site-packages
 * <venvDir>` (idempotent — a `pyvenv.cfg` already present means a prior run
 * got at least that far), then install its deps — from `gitRequirementsInstall`
 * (clone + `pip install -r requirements.txt`), from flat `pipPackages`, or
 * both — using THIS venv's own interpreter (`-m pip` rather than invoking
 * `<venvDir>/bin/pip` directly, since a venv's pip shebang can exceed some
 * platforms' shebang length limit).
 *
 * `--system-site-packages` is the whole trick: it lets this venv READ
 * comfy's already-installed torch/numpy/etc (so packs don't each download
 * their own ~3 GB torch) while anything `pip install`ed FROM WITHIN this venv
 * still lands in the venv's own site-packages, which sits ahead of the
 * system site on `sys.path` — so a pack's pins can shadow comfy's without
 * ever being able to uninstall or overwrite them. That property is why every
 * pack dependency now lives in a `VenvComponent` — see registry.ts's header
 * comment for the production incident this replaces.
 *
 * Idempotency: `component.markerFile`, independent of the owning pack's own
 * marker, so a pack that's already marked installed still gets a venv added
 * by a later revision when the user re-runs install.
 */
async function ensureVenvComponent(component: VenvComponent, log: LogFn): Promise<void> {
  if (fs.existsSync(component.markerFile)) {
    log(`Venv marker present for ${component.label} — skipping venv provision`);
    return;
  }
  const pyvenvCfg = path.join(component.venvDir, 'pyvenv.cfg');
  // "A venv exists" is NOT sufficient when the component pins a Python
  // version: a venv left behind by an earlier revision (or a failed run) can
  // be built on the WRONG interpreter, and reusing it silently reintroduces
  // the very error the pin exists to fix ("Package 'indextts' requires a
  // different Python: 3.12.13 not in '<3.12,>=3.10'"). Verify the existing
  // venv's version and rebuild from scratch when it doesn't match.
  if (fs.existsSync(pyvenvCfg) && component.pythonVersion) {
    const cfg = fs.readFileSync(pyvenvCfg, 'utf8');
    const found = /^version(?:_info)?\s*=\s*(\d+)\.(\d+)/m.exec(cfg);
    const want = component.pythonVersion.split('.').slice(0, 2).join('.');
    const have = found ? `${found[1]}.${found[2]}` : 'unknown';
    if (have !== want) {
      log(`Existing venv at ${component.venvDir} is Python ${have}, need ${want} — recreating`);
      await fs.promises.rm(component.venvDir, { recursive: true, force: true });
    }
  }
  // A venv missing pip is unusable for the install step below (uv-created
  // venvs are unseeded unless --seed was passed). Same reasoning as the
  // version check above: "the directory exists" is not the same as "the
  // directory works", and silently reusing a broken one just reproduces the
  // original failure on every retry.
  if (fs.existsSync(pyvenvCfg) && !fs.existsSync(path.join(component.venvDir, 'bin', 'pip'))) {
    log(`Existing venv at ${component.venvDir} has no pip — recreating`);
    await fs.promises.rm(component.venvDir, { recursive: true, force: true });
  }
  if (fs.existsSync(pyvenvCfg)) {
    log(`Venv directory already present at ${component.venvDir} — skipping venv creation`);
  } else {
    fs.mkdirSync(path.dirname(component.venvDir), { recursive: true, mode: 0o755 });
    let cmd: string;
    let args: string[];
    if (component.pythonVersion) {
      // Version-pinned component: `uv` provisions the interpreter itself,
      // downloading a standalone CPython when the image doesn't ship one
      // (IndexTTS2 needs <3.12; this image has 3.12.13 only). Deliberately
      // NO --system-site-packages: comfy's site-packages are 3.12 builds and
      // are ABI-incompatible with another minor version, so this venv must
      // carry its own full dependency set.
      cmd = 'uv';
      // --seed installs pip/setuptools/wheel. `uv venv` omits them by
      // default (uv installs packages with its own resolver), but the
      // dependency install below goes through `<venv>/bin/python -m pip`,
      // which fails with "No module named pip" on an unseeded venv.
      args = ['venv', '--seed', '--python', component.pythonVersion, component.venvDir];
    } else {
      cmd = python();
      args = ['-m', 'venv', '--system-site-packages', component.venvDir];
    }
    log(`Executing: ${cmd} ${args.join(' ')}`);
    const r = await run(cmd, args, { timeoutMs: VENV_CREATE_TIMEOUT_MS });
    if (r.stdout) log(`venv stdout: ${r.stdout.trim()}`);
    if (r.stderr) log(`venv stderr: ${r.stderr.trim()}`);
    if (r.code !== 0) throw new Error(`venv creation failed for ${component.id} (code=${r.code})`);
  }
  const venvPython = venvPythonBin(component);
  if (component.gitRequirementsInstall) {
    await cloneGitRepo(component.gitRequirementsInstall.repoUrl, component.gitRequirementsInstall.cloneDir, log);
    await pipInstallRequirements(venvPython, component.gitRequirementsInstall.cloneDir, log);
  }
  if (component.pipPackages.length > 0) {
    await pipInstallInVenv(venvPython, component.pipPackages, log);
  }
  fs.mkdirSync(path.dirname(component.markerFile), { recursive: true, mode: 0o755 });
  fs.writeFileSync(component.markerFile, `${new Date().toISOString()}\n`);
}

function writeMarker(pack: PackDefinition): void {
  fs.mkdirSync(path.dirname(pack.markerFile), { recursive: true, mode: 0o755 });
  fs.writeFileSync(pack.markerFile, `${new Date().toISOString()}\n`);
}

async function runInstall(taskId: string, pack: PackDefinition): Promise<void> {
  const log = makeLog(taskId);
  try {
    // Every component has its own idempotency (component.markerFile), so
    // this loop is safe to run unconditionally on every install call — a
    // pack that's already fully installed just short-circuits component by
    // component, and a pack with a component added by a later revision picks
    // up exactly that new component without needing to bump the pack's own
    // marker version.
    for (const [i, component] of pack.venvComponents.entries()) {
      const base = Math.round((i / pack.venvComponents.length) * 45);
      updateProgress(taskId, base, `Provisioning ${component.label} venv`);
      await ensureVenvComponent(component, log);
    }
    updateProgress(taskId, 50, 'Downloading models');
    // Only models that are SELECTED get downloaded here — either the
    // registry's `default: true` (no DB row / no override yet) or an
    // explicit `pack_models.selected = 1` deviation. This is the fix for
    // the "everything is hardcoded" half of the production incident this
    // feature exists for: a full pack install used to unconditionally pull
    // every model in the list (3x ~19 GB ACE-Step checkpoints) with no way
    // to opt out short of editing source.
    const selectedModels = pack.models.filter((m) => isModelSelected(pack.id, m.id, m.default));
    for (const [i, model] of selectedModels.entries()) {
      const base = 50 + Math.round((i / Math.max(1, selectedModels.length)) * 45);
      updateProgress(taskId, base, `Downloading ${model.label}`);
      await downloadPackModel(pack.id, model, log);
    }
    writeMarker(pack);
    packsRepo.setInstalled(pack.id, true, 'v1');
    bus.emit('pack:installed', { packId: pack.id });
    const msg = `Installed ${pack.label}`;
    log(msg);
    completeTask(taskId, true, msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Install failed: ${msg}`);
    completeTask(taskId, false, `Install failed: ${msg}`);
  }
}

/** Public: kick off (or reuse an in-flight) pack install. Returns taskId. */
export function installPack(id: string): string {
  const pack = getPack(id);
  if (!pack) throw new Error(`Unknown pack: ${id}`);
  const taskId = randomUUID();
  createTask(taskId, pack.id, 'install');
  void runInstall(taskId, pack);
  return taskId;
}

// ---- Uninstall ----
//
// Every pack dependency now lives in a `VenvComponent`'s own venv directory
// (see registry.ts's header comment) — that venv directory IS the pack's
// entire pip-installed footprint, so removing it is a complete dependency
// uninstall (nothing is left behind in any shared site). What's deliberately
// left on disk: git clones (e.g. ai-toolkit's `AI_TOOLKIT_DIR` source
// checkout — re-installing re-provisions the venv against the existing
// clone rather than re-cloning) and downloaded models (a heavy pack's model
// weights are multi-GB; deleting them risks losing a re-download the user
// didn't intend to discard). Revisit if a "full wipe" uninstall UX is
// designed later (e.g. a confirmation that explains what stays on disk).
async function runUninstall(taskId: string, pack: PackDefinition): Promise<void> {
  const log = makeLog(taskId);
  try {
    for (const [i, component] of pack.venvComponents.entries()) {
      const base = Math.round((i / pack.venvComponents.length) * 80);
      updateProgress(taskId, base, `Removing ${component.label} venv`);
      log(`Removing venv directory ${component.venvDir}`);
      await fs.promises.rm(component.venvDir, { recursive: true, force: true });
      await fs.promises.rm(component.markerFile, { force: true });
    }
    updateProgress(taskId, 90, 'Removing marker');
    await fs.promises.rm(pack.markerFile, { force: true });
    packsRepo.setInstalled(pack.id, false);
    bus.emit('pack:removed', { packId: pack.id });
    const msg = `Uninstalled ${pack.label} (venvs removed; git clones + downloaded models left on disk)`;
    log(msg);
    completeTask(taskId, true, msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Uninstall failed: ${msg}`);
    completeTask(taskId, false, `Uninstall failed: ${msg}`);
  }
}

/** Public: kick off pack uninstall (venv removal, see comment above). Returns taskId. */
export function uninstallPack(id: string): string {
  const pack = getPack(id);
  if (!pack) throw new Error(`Unknown pack: ${id}`);
  const taskId = randomUUID();
  createTask(taskId, pack.id, 'uninstall');
  void runUninstall(taskId, pack);
  return taskId;
}

// ---- Single-model download / remove (settings page) ----
//
// Reuses the exact same `downloadPackModel` helper `runInstall`'s bulk loop
// calls, and the same fire-and-forget task/progress/WS-broadcast machinery
// `installPack`/`uninstallPack` use — just scoped to one model instead of a
// whole pack, for `POST /packs/:id/models/:modelId/download`.

async function runModelDownload(taskId: string, packId: PackId, model: PackModelDef): Promise<void> {
  const log = makeLog(taskId);
  try {
    updateProgress(taskId, 5, `Downloading ${model.label}`);
    await downloadPackModel(packId, model, log);
    const msg = `Downloaded ${model.label}`;
    log(msg);
    completeTask(taskId, true, msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Download failed: ${msg}`);
    completeTask(taskId, false, `Download failed: ${msg}`);
  }
}

/**
 * Public: kick off a single model download. Callers MUST validate `packId`/
 * `modelId` against the registry first (`getPackModel`) — this throws on an
 * unknown pack/model rather than silently no-op'ing, but route handlers
 * should still 404 before ever reaching here so the error message a client
 * sees is consistent with every other unknown-id route.
 */
export function downloadPackModelTask(packId: string, modelId: string): string {
  const pack = getPack(packId);
  if (!pack) throw new Error(`Unknown pack: ${packId}`);
  const model = getPackModel(packId, modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  const taskId = randomUUID();
  createTask(taskId, pack.id, 'model-download');
  void runModelDownload(taskId, pack.id, model);
  return taskId;
}

/**
 * Public: synchronously delete a downloaded model from disk and mark it
 * `absent`. Not a background task (no taskId) — a directory `rm -rf` is fast
 * enough to do inline, unlike a multi-GB network download.
 */
export function removePackModel(packId: string, modelId: string): { dest: string; removed: boolean } {
  const pack = getPack(packId);
  if (!pack) throw new Error(`Unknown pack: ${packId}`);
  const model = getPackModel(packId, modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  const repo = effectiveRepo(pack.id, model.id, model.repo);
  const dest = effectiveDest(pack.id, model.id, model.kind, repo, model.repoSubfolder);
  let removed = false;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    removed = true;
  }
  packModelsRepo.setState(pack.id, model.id, 'absent', { dest: null, sizeBytes: null, downloadedAt: null });
  return { dest, removed };
}
