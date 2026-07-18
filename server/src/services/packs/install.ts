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
import {
  getPack,
  venvPythonBin,
  type GitRequirementsInstall,
  type ModelDownloadSpec,
  type PackDefinition,
  type VenvComponent,
} from './registry.js';

function python(): string {
  return env.PYTHON_PATH || 'python3';
}

const PIP_INSTALL_TIMEOUT_MS = 20 * 60 * 1000; // packs pull in heavier deps than a single plugin
const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const VENV_CREATE_TIMEOUT_MS = 3 * 60 * 1000;

// ---- In-memory progress (mirrors services/plugins/history.ts's Progress section) ----

export type PackTaskType = 'install' | 'uninstall';

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

function createTask(taskId: string, packId: string, type: PackTaskType): void {
  tasks.set(taskId, { taskId, packId, type, progress: 0, completed: false, logs: [] });
}

function addLog(taskId: string, message: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.logs.push(`[${new Date().toLocaleString()}] ${message}`);
}

function updateProgress(taskId: string, progress: number, message?: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.progress = progress;
  if (message !== undefined) t.message = message;
}

function completeTask(taskId: string, success: boolean, message?: string): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.completed = true;
  t.progress = success ? 100 : 0;
  if (message !== undefined) t.message = message;
  // Grace window keeps the final state pollable briefly; `unref` so the
  // timer never blocks process exit.
  setTimeout(() => tasks.delete(taskId), 30_000).unref();
}

export function getInstallProgress(taskId: string): PackTaskProgress | null {
  return tasks.get(taskId) ?? null;
}

type LogFn = (message: string) => void;

function makeLog(taskId: string): LogFn {
  return (msg: string) => {
    addLog(taskId, msg);
    logger.info(`[pack install ${taskId}] ${msg}`);
  };
}

// ---- Install steps ----

async function pipInstallPackages(pkgs: string[], log: LogFn): Promise<void> {
  if (pkgs.length === 0) { log('No pip packages declared'); return; }
  const args = ['-m', 'pip', 'install', '--user', ...pkgs];
  log(`Executing: ${python()} ${args.join(' ')}`);
  const r = await run(python(), args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`pip install failed (code=${r.code})`);
}

/**
 * Download one `{repo, dest}` model via `huggingface_hub.snapshot_download`,
 * shelled out to python -c (argv-only — the script is a single argv element,
 * never concatenated into a shell string). Mirrors the same primitive
 * ace-step-ui's own Dockerfile uses for its whisper-large-v3 prewarm.
 */
async function downloadModel(spec: ModelDownloadSpec, log: LogFn): Promise<void> {
  fs.mkdirSync(spec.dest, { recursive: true, mode: 0o755 });
  const code = [
    'from huggingface_hub import snapshot_download',
    `snapshot_download(repo_id=${JSON.stringify(spec.repo)}, local_dir=${JSON.stringify(spec.dest)})`,
  ].join('\n');
  log(`Downloading ${spec.repo} -> ${spec.dest}`);
  const r = await run(python(), ['-c', code], { timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS });
  if (r.stdout) log(`download stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`download stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`model download failed for ${spec.repo} (code=${r.code})`);
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
 * `pip install --user -r requirements.txt` from inside a cloned repo that
 * has no real packaging metadata (no setup.py/pyproject.toml — just a
 * requirements.txt at the root, ai-toolkit's actual shape). `cwd: cloneDir`
 * matters: some requirements.txt files reference sibling files via relative
 * `-r other.txt` includes (ai-toolkit's does — `requirements_base.txt`).
 */
async function pipInstallRequirements(cloneDir: string, log: LogFn): Promise<void> {
  const requirementsPath = path.join(cloneDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements.txt not found in clone: ${requirementsPath}`);
  }
  const args = ['-m', 'pip', 'install', '--user', '-r', requirementsPath];
  log(`Executing: ${python()} ${args.join(' ')} (cwd=${cloneDir})`);
  const r = await run(python(), args, { cwd: cloneDir, timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`pip install -r requirements.txt failed (code=${r.code})`);
}

async function runGitRequirementsInstall(spec: GitRequirementsInstall, log: LogFn): Promise<void> {
  await cloneGitRepo(spec.repoUrl, spec.cloneDir, log);
  await pipInstallRequirements(spec.cloneDir, log);
}

/**
 * Provision one `VenvComponent`: `python3 -m venv <venvDir>` (idempotent —
 * a `pyvenv.cfg` already present means a prior run got at least that far),
 * then `<venvDir's python> -m pip install <pipPackages>` (using `-m pip`
 * rather than invoking `<venvDir>/bin/pip` directly, since a venv's pip
 * shebang can exceed some platforms' shebang length limit). Fully isolated
 * from the pack's shared `--user` site — see `VenvComponent`'s doc comment
 * in registry.ts for why this exists (IndexTTS2's conflicting pins).
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
  if (fs.existsSync(pyvenvCfg)) {
    log(`Venv directory already present at ${component.venvDir} — skipping venv creation`);
  } else {
    fs.mkdirSync(path.dirname(component.venvDir), { recursive: true, mode: 0o755 });
    const args = ['-m', 'venv', component.venvDir];
    log(`Executing: ${python()} ${args.join(' ')}`);
    const r = await run(python(), args, { timeoutMs: VENV_CREATE_TIMEOUT_MS });
    if (r.stdout) log(`venv stdout: ${r.stdout.trim()}`);
    if (r.stderr) log(`venv stderr: ${r.stderr.trim()}`);
    if (r.code !== 0) throw new Error(`python3 -m venv failed for ${component.id} (code=${r.code})`);
  }
  if (component.pipPackages.length > 0) {
    const venvPython = venvPythonBin(component);
    const args = ['-m', 'pip', 'install', ...component.pipPackages];
    log(`Executing: ${venvPython} ${args.join(' ')}`);
    const r = await run(venvPython, args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
    if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
    if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
    if (r.code !== 0) throw new Error(`pip install failed inside ${component.id} venv (code=${r.code})`);
  }
  fs.mkdirSync(path.dirname(component.markerFile), { recursive: true, mode: 0o755 });
  fs.writeFileSync(component.markerFile, `${new Date().toISOString()}\n`);
}

function markerExists(pack: PackDefinition): boolean {
  return fs.existsSync(pack.markerFile);
}

function writeMarker(pack: PackDefinition): void {
  fs.mkdirSync(path.dirname(pack.markerFile), { recursive: true, mode: 0o755 });
  fs.writeFileSync(pack.markerFile, `${new Date().toISOString()}\n`);
}

async function runInstall(taskId: string, pack: PackDefinition): Promise<void> {
  const log = makeLog(taskId);
  try {
    if (markerExists(pack)) {
      log('Marker file present — skipping pip/clone install');
    } else {
      if (pack.gitRequirementsInstall) {
        updateProgress(taskId, 5, 'Cloning repository');
        await runGitRequirementsInstall(pack.gitRequirementsInstall, log);
      }
      if (pack.pipPackages.length > 0) {
        updateProgress(taskId, pack.gitRequirementsInstall ? 40 : 5, 'Installing pip packages');
        await pipInstallPackages(pack.pipPackages, log);
      }
    }
    // Venv components have their own idempotency (component.markerFile) and
    // are checked unconditionally — not nested under `markerExists(pack)`
    // above — so a pack that's already marked installed still gets a venv
    // added by a later revision when the user re-runs install, without
    // needing to bump the pack's own marker version.
    if (pack.venvComponents && pack.venvComponents.length > 0) {
      for (const [i, component] of pack.venvComponents.entries()) {
        const base = 40 + Math.round((i / pack.venvComponents.length) * 10);
        updateProgress(taskId, base, `Provisioning ${component.label} venv`);
        await ensureVenvComponent(component, log);
      }
    }
    updateProgress(taskId, 50, 'Downloading models');
    for (const [i, model] of pack.models.entries()) {
      const base = 50 + Math.round((i / Math.max(1, pack.models.length)) * 45);
      updateProgress(taskId, base, `Downloading ${model.repo}`);
      await downloadModel(model, log);
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
// TODO: this only flips the DB flag + removes the marker file. It does NOT
// uninstall the pip packages or delete downloaded models — a heavy pack's
// deps may be entangled with other packs/plugins that pip can't safely
// unwind, and model deletion risks losing a multi-GB re-download the user
// didn't intend to discard. Revisit once a real uninstall UX is designed
// (e.g. a confirmation that explains what stays on disk).
async function runUninstall(taskId: string, pack: PackDefinition): Promise<void> {
  const log = makeLog(taskId);
  try {
    updateProgress(taskId, 50, 'Removing marker');
    await fs.promises.rm(pack.markerFile, { force: true });
    packsRepo.setInstalled(pack.id, false);
    bus.emit('pack:removed', { packId: pack.id });
    const msg = `Uninstalled ${pack.label} (pip packages + models left on disk)`;
    log(msg);
    completeTask(taskId, true, msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Uninstall failed: ${msg}`);
    completeTask(taskId, false, `Uninstall failed: ${msg}`);
  }
}

/** Public: kick off pack uninstall (state-flip only, see TODO above). Returns taskId. */
export function uninstallPack(id: string): string {
  const pack = getPack(id);
  if (!pack) throw new Error(`Unknown pack: ${id}`);
  const taskId = randomUUID();
  createTask(taskId, pack.id, 'uninstall');
  void runUninstall(taskId, pack);
  return taskId;
}
