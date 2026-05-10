// Skills subsystem: registry + sandboxed script execution.
//
// Skills live in folders: <skillsDir>/<name>/SKILL.md
// User dir overlays bundled dir: user file wins on name collision.
//
// Script execution security policy (L1–L4 below) is intentionally
// documented on runSkillScript, not summarised here.

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { paths } from '../../config/paths.js';
import { currentConfigRootOverride } from '../../config/env.js';
import { safeResolve, atomicWrite } from '../../lib/fs.js';
import { parseFrontmatter } from './markdownLibrary/frontmatter.js';
import { isValidLibraryName } from './markdownLibrary/nameValidation.js';
import * as settings from '../settings/index.js';

// ---------- Types ----------

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  trigger_when?: string;
  scripts?: string[];
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
  description: string;
  /** Names of bundled script files under the skill's scripts/ directory. */
  scripts: string[];
}

export interface SkillIndex {
  name: string;
  description: string;
}

export interface ScriptRunInput {
  skillName: string;
  scriptName: string;
  input?: unknown;
}

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

// ---------- Paths ----------

export function getUserSkillsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'skills');
}

export function getBundledSkillsDir(): string {
  return paths.bundledSkillsDir;
}

// ---------- Registry ----------

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function parseSkill(name: string, raw: string): Skill {
  const { frontmatter, body } = parseFrontmatter(raw);
  const fm = frontmatter as SkillFrontmatter;

  let description = '';
  if (typeof fm.description === 'string' && fm.description.length > 0) {
    description = fm.description;
  } else {
    const firstLine = body.split('\n').find(l => l.trim().length > 0) ?? '';
    const clean = firstLine.replace(/^#+\s*/, '').trim();
    description = clean.length > 120 ? clean.slice(0, 120) : clean;
  }

  const scripts = Array.isArray(fm.scripts)
    ? fm.scripts.filter((s): s is string => typeof s === 'string')
    : [];

  return { name, frontmatter: fm, body, description, scripts };
}

function loadSkillFromDir(dir: string, name: string): Skill | null {
  try {
    const skillFile = safeResolve(path.join(dir, name), 'SKILL.md');
    const raw = readFileSafe(skillFile);
    if (raw !== null) return parseSkill(name, raw);
  } catch { /* escaped or not found */ }
  return null;
}

/** List all skills, user dir wins over bundled on name collision. */
export function listSkills(): Skill[] {
  const map = new Map<string, Skill>();

  for (const dir of [getBundledSkillsDir(), getUserSkillsDir()]) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!isValidLibraryName(name)) continue;
      const skill = loadSkillFromDir(dir, name);
      if (skill) map.set(name, skill);
    }
  }

  const items = [...map.values()];
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/** Load a single skill by name. User dir checked first. */
export function getSkill(name: string): Skill | null {
  if (!isValidLibraryName(name)) return null;
  return loadSkillFromDir(getUserSkillsDir(), name)
    ?? loadSkillFromDir(getBundledSkillsDir(), name);
}

/** Return the markdown body of a skill, or null if not found. */
export function getSkillBody(name: string): string | null {
  return getSkill(name)?.body ?? null;
}

/** Write a SKILL.md to the user dir. Creates directory if needed. */
export function putSkill(name: string, body: string): void {
  if (!isValidLibraryName(name)) throw new Error(`Invalid skill name: ${name}`);
  const skillDir = path.join(getUserSkillsDir(), name);
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  const skillFile = safeResolve(skillDir, 'SKILL.md');
  atomicWrite(skillFile, body);
}

/**
 * Delete a SKILL.md from the user dir. Returns true when deleted.
 * Returns false when no user file exists (bundled-only skills cannot be deleted).
 */
export function deleteSkill(name: string): boolean {
  if (!isValidLibraryName(name)) throw new Error(`Invalid skill name: ${name}`);
  const skillDir = path.join(getUserSkillsDir(), name);
  let skillFile: string;
  try { skillFile = safeResolve(skillDir, 'SKILL.md'); } catch { return false; }
  try {
    fs.unlinkSync(skillFile);
    return true;
  } catch {
    return false;
  }
}

/** Whether a skill exists only in the bundled dir. */
export function isSkillBundledOnly(name: string): boolean {
  if (!isValidLibraryName(name)) return false;
  const userSkill = loadSkillFromDir(getUserSkillsDir(), name);
  if (userSkill) return false;
  return loadSkillFromDir(getBundledSkillsDir(), name) !== null;
}

/** Compact index for embedding in system prompts. */
export function listSkillIndex(): SkillIndex[] {
  return listSkills().map(s => ({ name: s.name, description: s.description }));
}

// ---------- Script runner ----------

// SECURITY policy — four layers:
// L1 — Declared-only: only scripts listed in frontmatter.scripts run, even if
//      a matching file exists in scripts/. Stops undeclared file injection.
// L2 — Bundled-only by default: user-dir skill scripts blocked unless
//      chatEnableUserSkillScripts=true. Stops third-party skill code running
//      without explicit opt-in.
// L3 — Env scrub: spawn with minimal env (PATH/LANG/HOME→tmpdir) — Studio
//      secrets, API keys, and config root are not visible to the child.
// L4 — Shape guards: filename regex, safeResolve path-traversal guard,
//      30 s timeout, 1 MB stdout cap, EPIPE-swallowing stdin write.

const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.(py|js|sh)$/;
const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 1024 * 1024; // 1 MB
const TRUNCATION_MARKER = '\n[output truncated]\n';

function detectInterpreter(scriptName: string): string {
  if (scriptName.endsWith('.py')) return 'python3';
  if (scriptName.endsWith('.js')) return 'node';
  return 'bash';
}

interface ResolvedScript {
  scriptPath: string;
  skillDir: string;
  source: 'user' | 'bundled';
}

/**
 * Resolve which skill/script directory the request maps to. Searches user
 * dir first then bundled. Throws if neither has a `scripts/<scriptName>`
 * file under the skill, or if a path-traversal attempt is detected.
 */
function resolveScriptPath(skillName: string, scriptName: string): ResolvedScript {
  for (const [baseDir, source] of [
    [getUserSkillsDir(), 'user'] as const,
    [getBundledSkillsDir(), 'bundled'] as const,
  ]) {
    const skillDir = path.join(baseDir, skillName);
    try {
      const scriptsDir = safeResolve(skillDir, 'scripts');
      const scriptPath = safeResolve(scriptsDir, scriptName);
      // safeResolve doesn't check existence — verify here so we fall through
      // to the next dir when the user dir holds the skill but no script.
      if (!fs.existsSync(scriptPath)) continue;
      return { scriptPath, skillDir, source };
    } catch { /* escaped path or dir missing */ }
  }
  throw new Error(`Script not found: ${skillName}/scripts/${scriptName}`);
}

/**
 * Build a minimal env for the child process. Strips every variable Studio
 * inherited at boot — including STUDIO_CONFIG_ROOT, secret tokens, the
 * Ollama URL, etc. HOME is pointed at a fresh tmpdir so user-config dotfiles
 * aren't picked up by python or bash rc files.
 */
function buildSandboxEnv(skillDir: string): NodeJS.ProcessEnv {
  // Per-invocation tmpdir for HOME. The child's cwd is the skill dir for
  // relative-file access; this tmpdir is purely to isolate dotfile reads.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: tmpHome,
    TMPDIR: tmpHome,
    // Force unbuffered stdout so output streams within our timeout.
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    // `.` lets scripts reference sibling files without exposing the absolute
    // install path. Scripts needing the absolute path can call `realpath .`.
    SKILL_DIR: '.',
  };
  void skillDir; // cwd is set to skillDir on spawn; not needed in env
}

function cleanupTmpHome(tmpHome: string | undefined): void {
  if (!tmpHome) return;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  catch { /* tmp leftover is harmless */ }
}

/**
 * Run an allowlisted skill script under the layered security policy.
 *
 * Validation order:
 *   1. Skill name shape (isValidLibraryName)
 *   2. Script name shape (SCRIPT_NAME_RE)
 *   3. Skill exists + script declared in frontmatter.scripts  (L1)
 *   4. Bundled-only gate; user-dir blocked unless opt-in flag set  (L2)
 *   5. Spawn under env-scrubbed sandbox; timeout + stdout cap apply  (L3/L4)
 */
export function runSkillScript(args: ScriptRunInput): Promise<ScriptRunResult> {
  const { skillName, scriptName, input } = args;

  if (!isValidLibraryName(skillName)) {
    return Promise.reject(new Error(`Invalid skill name: ${skillName}`));
  }
  if (!SCRIPT_NAME_RE.test(scriptName)) {
    return Promise.reject(new Error(`Invalid script name: ${scriptName}`));
  }

  // L1 — script must be declared in the skill's frontmatter.scripts allowlist.
  const skill = getSkill(skillName);
  if (!skill) {
    return Promise.reject(new Error(`Skill not found: ${skillName}`));
  }
  if (!skill.scripts.includes(scriptName)) {
    return Promise.reject(new Error(
      `Script "${scriptName}" is not declared in ${skillName}/SKILL.md frontmatter.scripts allowlist`,
    ));
  }

  let resolved: ResolvedScript;
  try {
    resolved = resolveScriptPath(skillName, scriptName);
  } catch (err) {
    return Promise.reject(err);
  }

  // L2 — bundled-only by default. User-dir scripts require explicit opt-in
  // because anyone with write access to the config root could drop arbitrary
  // code there.
  if (resolved.source === 'user' && !settings.getChatEnableUserSkillScripts()) {
    return Promise.reject(new Error(
      `User-dir skill scripts are disabled. Set chatEnableUserSkillScripts=true to allow.`,
    ));
  }

  const interpreter = detectInterpreter(scriptName);
  const env = buildSandboxEnv(resolved.skillDir);
  const tmpHome = env.HOME;

  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, [resolved.scriptPath], {
      cwd: resolved.skillDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,                              // L3 — scrubbed env, no secrets
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    const finalize = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      cleanupTmpHome(tmpHome);
      cb();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > STDOUT_MAX_BYTES) {
        stdout = stdout.slice(0, STDOUT_MAX_BYTES) + TRUNCATION_MARKER;
        truncated = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finalize(() => reject(new Error(`Script timed out after ${TIMEOUT_MS}ms`)));
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      finalize(() => reject(err));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finalize(() => resolve({ stdout, stderr, exitCode: code, truncated }));
    });

    // Write input as JSON to stdin, then close. Swallow EPIPE — scripts may
    // close stdin before we finish writing.
    child.stdin.on('error', () => { /* expected when script ignores stdin */ });
    const stdinData = input !== undefined ? JSON.stringify(input) : '';
    child.stdin.write(stdinData, 'utf8');
    child.stdin.end();
  });
}
