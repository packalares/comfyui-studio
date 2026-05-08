// Run bundled skill scripts via child_process.spawn under a layered
// security policy.
//
// L1 — Declared-only: only scripts listed in the skill's
//      `frontmatter.scripts` allowlist are executable, even if a file with
//      a matching name exists in the `scripts/` dir.
// L2 — Bundled-only by default: user-dir skill scripts are blocked unless
//      `chatEnableUserSkillScripts` is true in settings. This stops a
//      hand-installed third-party skill from running code the user never
//      reviewed.
// L3 — Env scrub: spawn with a minimal env (PATH, LANG, HOME → tmpdir) so
//      Studio's secrets, API keys, and config root are not visible to
//      the child. cwd is the skill root, which holds only SKILL.md +
//      scripts/.
// L4 — Existing controls: filename regex (`^[a-z0-9][a-z0-9._-]*\.(py|js|sh)$`),
//      `safeResolve` path-traversal guard, 30 s timeout, 1 MB stdout cap,
//      EPIPE-swallowing stdin write.

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { safeResolve } from '../../../lib/fs.js';
import { getUserSkillsDir, getBundledSkillsDir, getSkill } from './registry.js';
import { isValidLibraryName } from '../markdownLibrary/nameValidation.js';
import * as settings from '../../settings.js';

const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.(py|js|sh)$/;
const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 1024 * 1024; // 1 MB
const TRUNCATION_MARKER = '\n[output truncated]\n';

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
 * inherited at boot — including `STUDIO_CONFIG_ROOT`, secret tokens, the
 * Ollama URL, etc. — so a compromised script can't simply read them.
 * `HOME` is pointed at a fresh tmpdir so user-config dotfiles aren't
 * picked up by python's site-packages search or bash's rc files.
 */
function buildSandboxEnv(skillDir: string): NodeJS.ProcessEnv {
  // Per-invocation tmpdir for HOME so the script can't dump state into
  // the user's real home and persist across calls. Created lazily; the
  // child runs in the skill's own dir for cwd, so this is purely a guard.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'));
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: tmpHome,
    TMPDIR: tmpHome,
    // Strip Python from looking in interactive paths; force unbuffered
    // so stdout streams promptly within our timeout.
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    // Skill scripts run with `cwd` set to the skill's directory, so a literal
    // `.` lets them reference sibling files (`$SKILL_DIR/template.txt`)
    // without exposing the absolute install path in the env. A script that
    // genuinely needs the absolute path can still call `realpath .`, but it
    // becomes an explicit choice rather than something we hand out.
    SKILL_DIR: '.',
  };
}

/**
 * Cleanup helper for the per-invocation HOME dir. Best-effort — failures
 * are not fatal because the dir is already isolated.
 */
function cleanupTmpHome(tmpHome: string | undefined): void {
  if (!tmpHome) return;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  catch { /* tmp leftover is harmless */ }
}

/**
 * Run an allowlisted skill script under the security policy.
 *
 * Validation order:
 *   1. Skill name shape (`isValidLibraryName`)
 *   2. Script name shape (`SCRIPT_NAME_RE`)
 *   3. Skill exists + has the script declared in `frontmatter.scripts`
 *   4. Resolve to either bundled or user dir; user-dir blocked unless
 *      `chatEnableUserSkillScripts` is true
 *   5. Spawn under env-scrubbed sandbox; existing timeout + stdout cap apply
 */
export function runSkillScript(args: ScriptRunInput): Promise<ScriptRunResult> {
  const { skillName, scriptName, input } = args;

  if (!isValidLibraryName(skillName)) {
    return Promise.reject(new Error(`Invalid skill name: ${skillName}`));
  }
  if (!SCRIPT_NAME_RE.test(scriptName)) {
    return Promise.reject(new Error(`Invalid script name: ${scriptName}`));
  }

  // L1 — script must be declared in the skill's frontmatter.scripts
  // allowlist. Reject anything else even if the file exists in scripts/.
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

  // L2 — bundled-only by default. User-dir scripts are higher risk because
  // anyone with write access to the config root could drop arbitrary code
  // there; they require explicit opt-in.
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
