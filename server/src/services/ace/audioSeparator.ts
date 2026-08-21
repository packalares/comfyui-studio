// Subprocess wrapper around the `audio-separator` CLI
// (https://github.com/nomadkaraoke/python-audio-separator) and the bundled
// `whisper_cli.py` batch-transcription script. Ported from ace-step-ui's
// `server/src/services/audioSeparator.ts`.
//
// Both are run server-side (GPU) for LoRA training-data preprocessing: strip
// instrumentation down to a clean vocal stem, then transcribe it so the
// dataset's `raw_lyrics` field is pre-populated (see
// `routes/ace/training.routes.ts`'s `/preprocess-stems` + `/transcribe-uploads`).
//
// GPU-scheduler ownership: DELETED relative to ace-step-ui —
// `ensureGpuEmptyForWhisper()` there manually probed ACE-Step's model
// inventory and `pkill -f acestep.api_server`'d it to free VRAM before
// Whisper ran, then polled `/health` for the FastAPI to come back. That
// hack existed because ace-step-ui had no cross-process GPU scheduler. comfy
// does: `services/gpu/scheduler.ts`'s `submitGpuJob('ace-stem-separate' |
// 'ace-whisper', ...)` calls `ensureResident('oneshot')` BEFORE invoking the
// callbacks below, which evicts ollama/comfy/ACE-Step correctly (including
// actually stopping ACE-Step's child process — see
// `services/gpu/residency.ts`'s `unloadAceStep`). Callers (routes/ace/
// training.routes.ts) MUST wrap every call here in `submitGpuJob`; nothing
// in this module touches GPU residency itself anymore.
//
// Raw `child_process.spawn` (not `lib/exec.ts`'s `run`) is used deliberately:
// both audio-separator and whisper_cli.py stream tqdm-style progress lines
// the caller wants live (job-log tailing in the UI), which `lib/exec.run`'s
// buffer-until-exit model can't provide. `shell: false` is passed explicitly
// everywhere, matching `lib/exec.ts`'s "argv-only, no shell" contract.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, unlink } from 'fs/promises';
import path from 'path';
import { aceWhisperPythonPathOverride, currentProcessEnv } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { getVenvComponent, resolvePackPython, resolveVenvBin } from '../packs/registry.js';

const WHISPER_CLI = paths.aceWhisperScript;
const MODEL_DIR = paths.aceStemSeparatorModelDir;

/**
 * `audio-separator` console-script entry point, pip-installed into the
 * `ace-step` pack's `main` venv (`services/packs/registry.ts`). Resolved at
 * call time (not module load, since the pack may not be installed yet) via
 * `resolveVenvBin` — this spawns the venv's OWN copy directly rather than
 * relying on a bare command name being on `PATH`, and throws a clear
 * "install the ace-step pack" error if the venv is missing.
 */
function resolveAudioSeparatorBin(): string {
  return resolveVenvBin('ace-step', 'main', 'audio-separator', 'Stem separation (audio-separator)');
}

/**
 * Resolve the Python interpreter for `whisper_cli.py` (faster-whisper batch
 * transcription). An explicit `ACE_WHISPER_PYTHON_PATH` override wins (e.g.
 * a hand-rolled venv this codebase doesn't track); otherwise resolves the
 * `ace-step` pack's `main` venv (registry-derived, not hardcoded), throwing
 * a clear "install the ace-step pack" error if it hasn't been provisioned.
 */
function resolveWhisperPython(): string {
  const override = aceWhisperPythonPathOverride();
  if (override) return override;
  return resolvePackPython('ace-step', 'main', 'Lyrics transcription (faster-whisper)');
}

export interface SeparateOptions {
  inputPaths: string[];                 // absolute file paths
  outputDir: string;                    // absolute, will be created
  model: string;                        // e.g. "MelBandRoformer.ckpt"
  keepStems?: string[];                 // case-insensitive, e.g. ["vocals"]
  chain?: string[];                     // chained pipeline: [stage1Model, stage2Model, ...]
  extraArgs?: Record<string, unknown>;  // forwarded as --key=value
  onProgress?: (msg: string) => void;
  onStdout?: (line: string) => void;
}

export interface SeparateOutput {
  input: string;
  stems: { name: string; path: string }[];
}

export interface SeparateResult {
  outputs: SeparateOutput[];
  totalDurationMs: number;
}

// audio-separator emits progress via tqdm. The percentage shows up in
// stderr as e.g.  "Separating: 42%|████" — match either stream.
const PROGRESS_RE = /(\d+)%\|/;

function buildArgs(
  input: string,
  model: string,
  outputDir: string,
  extra?: Record<string, unknown>,
  keepStems?: string[],
): string[] {
  const args = [
    input,
    '--model_filename', model,
    '--output_dir', outputDir,
    '--output_format', 'WAV',
    '--model_file_dir', MODEL_DIR,
    '--use_autocast',
  ];

  // When the caller wants exactly ONE stem out (e.g. voice-clone training
  // wants only the vocal stem), use audio-separator's --single_stem flag so
  // the CLI never writes the other stems. Avoids a race where a post-process
  // delete loop scans the dir before all stems are flushed.
  if (keepStems && keepStems.length === 1) {
    const stemName = keepStems[0];
    const titled = stemName.charAt(0).toUpperCase() + stemName.slice(1).toLowerCase();
    args.push('--single_stem', titled);
  }

  if (extra) {
    for (const [key, val] of Object.entries(extra)) {
      if (val === undefined || val === null) continue;
      const flag = key.startsWith('--') ? key : `--${key}`;
      if (typeof val === 'boolean') {
        if (val) args.push(flag);
      } else {
        args.push(flag, String(val));
      }
    }
  }

  return args;
}

/**
 * Spawn audio-separator for a single (input, model) pair. Resolves once the
 * process exits; rejects on non-zero status.
 */
function runOnce(
  input: string,
  model: string,
  outputDir: string,
  extra: Record<string, unknown> | undefined,
  onStdout?: (line: string) => void,
  onProgress?: (msg: string) => void,
  keepStems?: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(input, model, outputDir, extra, keepStems);
    const proc = spawn(resolveAudioSeparatorBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: currentProcessEnv() });

    let lastPct = -1;
    const pumpLine = (line: string) => {
      if (!line) return;
      onStdout?.(line);
      const m = line.match(PROGRESS_RE);
      if (m && onProgress) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(`${pct}%`);
        }
      }
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      let idx;
      // tqdm uses \r for in-place updates; split on either.
      while ((idx = stdoutBuf.search(/[\r\n]/)) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        pumpLine(line);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      let idx;
      while ((idx = stderrBuf.search(/[\r\n]/)) >= 0) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        pumpLine(line);
      }
    });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (stdoutBuf) pumpLine(stdoutBuf);
      if (stderrBuf) pumpLine(stderrBuf);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`audio-separator exited with code ${code} for ${path.basename(input)} using ${model}`));
      }
    });
  });
}

/**
 * Scan a directory for WAV stems produced for a given input basename.
 * audio-separator names files like:
 *   "<input_basename>_(<StemName>)_<modelName>.wav"
 */
async function findStemsFor(outputDir: string, inputBasename: string): Promise<{ name: string; path: string }[]> {
  if (!existsSync(outputDir)) return [];
  const entries = await readdir(outputDir);
  const escapedBase = inputBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stemRe = new RegExp(`^${escapedBase}_\\(([^)]+)\\)_.*\\.wav$`, 'i');

  const stems: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const m = entry.match(stemRe);
    if (m) {
      stems.push({ name: m[1], path: path.join(outputDir, entry) });
    }
  }
  return stems;
}

function matchesKeepList(stemName: string, keep: string[]): boolean {
  const lower = stemName.toLowerCase();
  return keep.some(k => k.toLowerCase() === lower);
}

/**
 * Drum-component chains (e.g. SCNet -> LarsNet to extract a kick stem) are
 * not yet supported by audio-separator's bundled model registry.
 *
 * TODO: when audio-separator adds LarsNet support (or a separate Python
 * helper is wired for it), replace this stub with a real two-stage
 * pipeline: run stage 1, keep "drums", run stage 2 on that for the
 * requested component ("kick", "snare", etc). For now only stage 1 runs and
 * a warning surfaces in the job log.
 */
function isChainSupported(_chain: string[]): boolean {
  return false;
}

/**
 * Resolve the standalone CUDA-12 cuBLAS/cuDNN lib dirs pip-installed by the
 * `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` packages (see
 * `services/packs/registry.ts`'s `ace-step` `main` component), so they can
 * be prepended to `LD_LIBRARY_PATH` when spawning `whisper_cli.py`. These
 * packages now live inside the `main` venv's OWN site-packages (never a
 * shared `~/.local` site), so this searches `<venvDir>/lib/pythonX.Y/
 * site-packages/nvidia/{cublas,cudnn}/lib` instead of the old shared-site
 * path.
 *
 * TODO: this whole workaround exists because ace-step-ui's base image was
 * CUDA 13 while faster-whisper's CTranslate2 backend is only built against
 * CUDA 12 (needing the standalone pip wheels above). comfy's base image
 * (per this port's task brief) is a CUDA 12.8 ("cu128") build, which may
 * mean CTranslate2 can already find its CUDA libs natively without this
 * LD_LIBRARY_PATH hack at all. Left in defensively (searching is cheap and
 * a no-op if the dirs don't exist) — remove once confirmed unnecessary on
 * comfy's actual runtime image.
 */
async function resolveCuda12LibPaths(): Promise<string[]> {
  const component = getVenvComponent('ace-step', 'main');
  if (!component) return [];
  const venvSiteLib = path.join(component.venvDir, 'lib');
  let pyDirs: string[] = [];
  try {
    pyDirs = (await readdir(venvSiteLib)).filter(d => d.startsWith('python3.'));
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const pyDir of pyDirs) {
    candidates.push(
      path.join(venvSiteLib, pyDir, 'site-packages', 'nvidia', 'cublas', 'lib'),
      path.join(venvSiteLib, pyDir, 'site-packages', 'nvidia', 'cudnn', 'lib'),
    );
  }
  return candidates.filter(p => existsSync(p));
}

/**
 * Run `whisper_cli.py` over a directory of audio files. Writes
 * `<basename>.txt` + `<basename>.lang.txt` next to each input file —
 * `build-dataset` picks them up automatically as `raw_lyrics`.
 *
 * Caller MUST already hold GPU residency for the `oneshot` tenant (i.e. be
 * running inside a `submitGpuJob('ace-whisper' | 'ace-stem-separate', ...)`
 * callback) — this function does not evict anything itself.
 */
export async function runWhisperBatch(
  inputDir: string,
  onStdout?: (line: string) => void,
): Promise<void> {
  if (!existsSync(WHISPER_CLI)) {
    onStdout?.(`[whisper] script not found at ${WHISPER_CLI}, skipping transcription`);
    return;
  }

  const cuda12Libs = await resolveCuda12LibPaths();
  const baseEnv = currentProcessEnv();
  const ldPath = [...cuda12Libs, baseEnv.LD_LIBRARY_PATH ?? ''].filter(Boolean).join(':');

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveWhisperPython(), [WHISPER_CLI, inputDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { ...baseEnv, LD_LIBRARY_PATH: ldPath },
    });

    let buf = '';
    const pump = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      let idx;
      while ((idx = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line) onStdout?.(line);
      }
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (buf) onStdout?.(buf);
      if (code === 0) resolve();
      else reject(new Error(`whisper_cli exited with code ${code}`));
    });
  });
}

export async function separateStems(opts: SeparateOptions): Promise<SeparateResult> {
  const { inputPaths, outputDir, model, keepStems, chain, extraArgs, onProgress, onStdout } = opts;

  await mkdir(outputDir, { recursive: true });
  await mkdir(MODEL_DIR, { recursive: true });

  const startedAt = Date.now();
  const outputs: SeparateOutput[] = [];

  const useChain = chain && chain.length > 1;
  if (useChain && !isChainSupported(chain)) {
    const msg = `[audio-separator] chain pipeline (${chain.join(' -> ')}) not yet supported — falling back to stage-1 model only`;
    onStdout?.(msg);
    onProgress?.(msg);
  }

  for (let i = 0; i < inputPaths.length; i++) {
    const input = inputPaths[i];
    if (!existsSync(input)) {
      throw new Error(`Input not found: ${input}`);
    }
    const inputBasename = path.basename(input, path.extname(input));

    onProgress?.(`(${i + 1}/${inputPaths.length}) ${path.basename(input)}`);
    onStdout?.(`[audio-separator] separating ${input} with ${model}`);

    await runOnce(input, model, outputDir, extraArgs, onStdout, onProgress, keepStems);

    // Brief settle to let audio-separator's filesystem writes flush before scanning.
    await new Promise(r => setTimeout(r, 250));
    const stems = await findStemsFor(outputDir, inputBasename);

    // Filter/cleanup based on keepStems. With --single_stem (above) the
    // unwanted stems are never written, so this is mostly a safety net for
    // multi-stem keep cases.
    let kept = stems;
    if (keepStems && keepStems.length > 0) {
      kept = stems.filter(s => matchesKeepList(s.name, keepStems));
      const dropped = stems.filter(s => !matchesKeepList(s.name, keepStems));
      for (const d of dropped) {
        try { await unlink(d.path); } catch { /* ignore */ }
      }
    }

    outputs.push({ input, stems: kept });
  }

  // After all stems are extracted, run Whisper on the output directory to
  // produce <basename>.txt + <basename>.lang.txt companions. The caller
  // already holds the 'oneshot' GPU slot (see the module header) for the
  // whole separateStems() call, so no residency handling happens here.
  if (keepStems && keepStems.some(s => /vocals?/i.test(s))) {
    try {
      onStdout?.(`[whisper] transcribing stems in ${outputDir}`);
      await runWhisperBatch(outputDir, onStdout);
    } catch (err) {
      onStdout?.(`[whisper] WARN: transcription failed (${err instanceof Error ? err.message : String(err)})`);
      // Don't fail the whole stem-extraction job — auto-label can still run,
      // just without preloaded lyrics.
    }
  }

  return {
    outputs,
    totalDurationMs: Date.now() - startedAt,
  };
}

/**
 * Transcribe a single audio file (not a whole directory). Stages a copy into
 * an ephemeral temp dir under `paths.uploadsTmpDir` (kept on the same
 * persistent volume as the DB rather than `/tmp`'s tmpfs — see that path's
 * doc comment), runs `whisper_cli.py` against it, reads back the resulting
 * `.txt`, then cleans up.
 *
 * Used by `routes/ace/referenceTrack.routes.ts`'s `POST /:id/transcribe` —
 * ace-step-ui's equivalent route shelled out to a generic system `whisper`
 * binary via a hand-rolled `findWhisperExecutable`/`spawn`; this reuses the
 * same faster-whisper CLI + GPU-scheduler-owned residency as the training
 * pipeline instead of depending on a second, unrelated Whisper install.
 *
 * Caller MUST already hold GPU residency for the `oneshot` tenant (i.e. be
 * running inside a `submitGpuJob('ace-whisper', ...)` callback).
 */
export async function transcribeSingleFile(
  inputPath: string,
  onStdout?: (line: string) => void,
): Promise<string | null> {
  await mkdir(paths.uploadsTmpDir, { recursive: true });
  const tmpDir = await mkdtemp(path.join(paths.uploadsTmpDir, 'ace-whisper-'));
  try {
    const ext = path.extname(inputPath) || '.wav';
    const staged = path.join(tmpDir, `input${ext}`);
    await copyFile(inputPath, staged);
    await runWhisperBatch(tmpDir, onStdout);
    const txtPath = path.join(tmpDir, 'input.txt');
    if (!existsSync(txtPath)) return null;
    const text = await readFile(txtPath, 'utf-8');
    return text.trim() || null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
}
