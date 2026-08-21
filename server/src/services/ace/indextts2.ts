// IndexTTS2 voice-clone inference. Ported from ace-step-ui's
// `server/src/services/indextts2.ts`. Spawns the bundled
// `data/ace/indextts2_infer.py` script as a one-shot subprocess.
//
// ace-step-ui required a SEPARATE uv-managed venv for IndexTTS2 (upstream
// pins torch==2.8 / transformers==4.52 / numpy==1.26, which conflict with
// ACE-Step's own pinned versions in the same image) — see the Dockerfile's
// dedicated `/app/indextts-src/.venv`. comfy's `ace-step` pack (see
// `services/packs/registry.ts`'s `venvComponents` + `services/packs/
// install.ts`'s `ensureVenvComponent`) mirrors that: it provisions a
// dedicated venv for IndexTTS2, isolated from the pack's shared `--user`
// site. `resolveIndexTts2Python()` below is the single resolution point for
// which interpreter to spawn — it derives the venv path from the pack
// registry rather than hardcoding it here too.
//
// Caller MUST already hold GPU residency for the `oneshot` tenant (i.e. be
// running inside a `submitGpuJob('ace-tts', ...)` callback) — this module
// does not touch GPU residency itself.

import { spawn } from 'child_process';
import { aceTtsPythonPathOverride, currentProcessEnv } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { resolvePackPython, PACKS } from '../packs/registry.js';
import { effectiveDest, effectiveRepo } from '../packs/settings.js';

export interface CloneOptions {
  refAudioPath: string;
  text: string;
  outputPath: string;
  emoAudioPath?: string;
  emoAlpha?: number;
  emoVector?: number[]; // 8-dim
  emoText?: string;
  fp16?: boolean;
  intervalSilence?: number;
  seed?: number;
  device?: string;
  modelDir?: string;
  onProgress?: (line: string) => void;
}

export interface CloneResult {
  outputPath: string;
  durationSeconds: number;
  totalElapsedMs: number;
}

/** IndexTTS2 model weights downloaded by the `ace-step` pack installer
 *  (see `services/packs/registry.ts`'s `models` list — `IndexTeam/IndexTTS-2`).
 *  Resolved through the same repo-override-aware helper the installer uses
 *  (`services/packs/settings.ts`) rather than a static `dest` field, since
 *  the destination is now derived from `kind` + the effective repo id. */
function resolvePackModelDir(): string | undefined {
  const model = PACKS['ace-step'].models.find((m) => m.kind === 'tts');
  if (!model) return undefined;
  return effectiveDest('ace-step', model.id, model.kind, effectiveRepo('ace-step', model.id, model.repo));
}

/**
 * Resolve the Python interpreter IndexTTS2 inference runs under.
 *
 * Resolution order:
 *   1. An explicit `ACE_TTS_PYTHON_PATH` override — the operator knows best
 *      (e.g. a hand-rolled venv this codebase doesn't track).
 *   2. The `ace-step` pack's dedicated `indextts2` venv component (see
 *      `services/packs/registry.ts`'s `venvComponents`), resolved via
 *      `resolvePackPython`, IF it has actually been provisioned on disk —
 *      install may not have run yet.
 *   3. Otherwise: throw. Silently falling back to plain `python3` would just
 *      trade this clear, actionable error for an opaque `ImportError: No
 *      module named 'indextts'` surfacing deep inside the spawned child.
 */
export function resolveIndexTts2Python(): string {
  const override = aceTtsPythonPathOverride();
  if (override) return override;
  return resolvePackPython('ace-step', 'indextts2', 'Voice-clone TTS (IndexTTS2)');
}

/**
 * Run the IndexTTS2 voice-clone subprocess and resolve when the WAV is on disk.
 * Throws with stderr included on a non-zero exit.
 */
export async function cloneVoiceTTS(opts: CloneOptions): Promise<CloneResult> {
  const args: string[] = [
    paths.aceIndexTts2Script,
    '--ref-audio', opts.refAudioPath,
    '--text', opts.text,
    '--output', opts.outputPath,
  ];

  if (opts.emoAudioPath) args.push('--emo-audio', opts.emoAudioPath);
  if (typeof opts.emoAlpha === 'number') args.push('--emo-alpha', String(opts.emoAlpha));
  if (opts.emoText) args.push('--emo-text', opts.emoText);
  if (opts.emoVector && opts.emoVector.length > 0) {
    args.push('--emo-vector', opts.emoVector.join(','));
  }
  if (opts.fp16 !== false) args.push('--fp16'); // default true
  if (typeof opts.intervalSilence === 'number') args.push('--interval-silence', String(opts.intervalSilence));
  if (typeof opts.seed === 'number') args.push('--seed', String(opts.seed));
  if (opts.device) args.push('--device', opts.device);
  const modelDir = opts.modelDir || resolvePackModelDir();
  if (modelDir) args.push('--model-dir', modelDir);

  const startedAt = Date.now();
  const childEnv = { ...currentProcessEnv(), PYTHONUNBUFFERED: '1' };
  // Fails loudly here (before ever spawning) if neither the pack-provisioned
  // venv nor an explicit override is available — see the doc comment above.
  const pythonBin = resolveIndexTts2Python();

  return new Promise<CloneResult>((resolve, reject) => {
    const proc = spawn(pythonBin, args, { env: childEnv, shell: false });

    let stdoutBuf = '';
    let stderrBuf = '';
    let lastProgress: Record<string, string> = {};

    const flushLines = (chunk: string, sink: (line: string) => void) => {
      const combined = stdoutBuf + chunk;
      const lines = combined.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line) sink(line);
      }
    };

    proc.stdout.on('data', (data: Buffer) => {
      flushLines(data.toString('utf8'), (line) => {
        if (line.startsWith('[INDEXTTS]')) {
          const kv: Record<string, string> = {};
          for (const tok of line.replace('[INDEXTTS]', '').trim().split(/\s+/)) {
            const idx = tok.indexOf('=');
            if (idx > 0) kv[tok.slice(0, idx)] = tok.slice(idx + 1);
          }
          lastProgress = { ...lastProgress, ...kv };
        }
        opts.onProgress?.(line);
      });
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stderrBuf += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) opts.onProgress?.(line);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn IndexTTS2 (${pythonBin}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (stdoutBuf) opts.onProgress?.(stdoutBuf);
      if (code === 0) {
        const duration = Number(lastProgress.duration_seconds) || 0;
        resolve({
          outputPath: opts.outputPath,
          durationSeconds: duration,
          totalElapsedMs: Date.now() - startedAt,
        });
        return;
      }
      let message = `IndexTTS2 exited with code ${code}`;
      const trimmed = stderrBuf.trim();
      if (trimmed) {
        try {
          const last = trimmed.split(/\r?\n/).filter(Boolean).pop();
          if (last) {
            const parsed = JSON.parse(last) as { error?: string };
            if (parsed?.error) {
              message = `IndexTTS2: ${parsed.error}`;
            }
          }
        } catch {
          message = `IndexTTS2 exited with code ${code}: ${trimmed.slice(-500)}`;
        }
      }
      reject(new Error(message));
    });
  });
}
