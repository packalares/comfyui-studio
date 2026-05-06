// Run bundled skill scripts via child_process.spawn.
// Isolated here so the MCP tool wrapper (Phase 4) can import just this module.

import { spawn } from 'child_process';
import path from 'path';
import { safeResolve } from '../../../lib/fs.js';
import { getUserSkillsDir, getBundledSkillsDir } from './registry.js';
import { isValidLibraryName } from '../markdownLibrary/nameValidation.js';

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
}

function detectInterpreter(scriptName: string): string {
  if (scriptName.endsWith('.py')) return 'python3';
  if (scriptName.endsWith('.js')) return 'node';
  return 'bash';
}

function resolveScriptPath(skillName: string, scriptName: string): string {
  // Check user dir first, then bundled dir.
  for (const baseDir of [getUserSkillsDir(), getBundledSkillsDir()]) {
    const skillDir = path.join(baseDir, skillName);
    try {
      // safeResolve guards against path traversal
      const scriptsDir = safeResolve(skillDir, 'scripts');
      const scriptPath = safeResolve(scriptsDir, scriptName);
      return scriptPath;
    } catch { /* escaped path or dir missing */ }
  }
  throw new Error(`Script not found: ${skillName}/scripts/${scriptName}`);
}

/**
 * Run a bundled skill script.
 * stdin receives JSON.stringify(input).
 * stdout is capped at 1 MB.
 * Times out after 30 seconds.
 */
export function runSkillScript(args: ScriptRunInput): Promise<ScriptRunResult> {
  const { skillName, scriptName, input } = args;

  if (!isValidLibraryName(skillName)) {
    return Promise.reject(new Error(`Invalid skill name: ${skillName}`));
  }
  if (!SCRIPT_NAME_RE.test(scriptName)) {
    return Promise.reject(new Error(`Invalid script name: ${scriptName}`));
  }

  const scriptPath = resolveScriptPath(skillName, scriptName);
  const interpreter = detectInterpreter(scriptName);
  const skillDir = path.dirname(path.dirname(scriptPath)); // skill root

  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, [scriptPath], {
      cwd: skillDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

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
      child.kill('SIGTERM');
      reject(new Error(`Script timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    // Write input as JSON to stdin, then close it.
    // Swallow EPIPE — the script may close stdin before we finish writing.
    child.stdin.on('error', () => { /* EPIPE is expected when script ignores stdin */ });
    const stdinData = input !== undefined ? JSON.stringify(input) : '';
    child.stdin.write(stdinData, 'utf8');
    child.stdin.end();
  });
}
