// Studio MCP tool: run a declared skill script under the layered security
// policy in `services/chat/skills/scriptRunner` (allowlist + bundled-only +
// env scrub + timeout/cap). The model can chain `studio_load_skill` →
// `studio_run_skill_script` so a skill's text instructions and helper
// scripts work together.

import { z } from 'zod';
import { runSkillScript } from '../../../../chat/skills/index.js';

export const description =
  'Run a declared script bundled with a skill. Only scripts listed in the '
  + 'skill\'s frontmatter `scripts:` allowlist are executable. Pass JSON '
  + '`input` (delivered to the script\'s stdin) and read the script\'s stdout '
  + 'from the result. Scripts time out after 30 s and stdout is capped at 1 MB. '
  + 'Use this when a skill\'s SKILL.md tells you to.';

export const inputShape = {
  skill: z.string().min(1).max(64)
    .describe('Skill name as listed in `studio_list_skills` / system prompt.'),
  script: z.string().min(1).max(128)
    .describe('Script filename (e.g. "expand.py"). Must end in .py / .js / .sh '
      + 'and be declared in the skill\'s SKILL.md `scripts:` frontmatter.'),
  input: z.unknown().optional()
    .describe('Optional JSON-serialisable value handed to the script via stdin.'),
};

export interface RunSkillScriptArgs {
  skill: string;
  script: string;
  input?: unknown;
}

export interface RunSkillScriptOutput {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  truncated?: boolean;
  error?: string;
}

export async function run(args: RunSkillScriptArgs): Promise<RunSkillScriptOutput> {
  try {
    const result = await runSkillScript({
      skillName: args.skill,
      scriptName: args.script,
      input: args.input,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
