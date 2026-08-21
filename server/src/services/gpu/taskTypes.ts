// Registry of GPU-bound task types with their tenant affinity and priority.
// Priority: lower number = higher priority, same priority = FIFO.
// tenant 'none' is not routed through the scheduler (no GPU contention).
// maxRuntimeMs: hard ceiling enforced by the scheduler watchdog. After this
// elapses on an active slot the watchdog force-releases (logs warn). Set
// generously per-task; the goal is to break leaks, not bound real work.

export const TASK_TYPES = {
  'llm-chat':          { tenant: 'ollama'    as const, priority: 10, maxRuntimeMs: 10 * 60 * 1000 },
  'llm-generate':      { tenant: 'ollama'    as const, priority: 10, maxRuntimeMs: 10 * 60 * 1000 },
  'llm-embeddings':    { tenant: 'ollama'    as const, priority: 10, maxRuntimeMs:  2 * 60 * 1000 },
  'comfy-generate':    { tenant: 'comfy'     as const, priority: 20, maxRuntimeMs: 45 * 60 * 1000 },
  'ace-step-generate': { tenant: 'ace-step'  as const, priority: 20, maxRuntimeMs: 30 * 60 * 1000 },
  // ACE-Step's `/format_input` prompt/lyrics formatter. Same tenant as
  // generation (it's the same resident LM), but a HIGHER priority and a short
  // cap: it's an interactive click that returns in seconds, so it should slot
  // in ahead of a queued 30-minute batch rather than block behind one. Sharing
  // the tenant means it never triggers an evict/reload cycle of its own.
  'ace-step-format':   { tenant: 'ace-step'  as const, priority: 10, maxRuntimeMs: 2 * 60 * 1000 },
  // TTS (IndexTTS2) and Whisper run as separate-venv one-shot python processes
  // that cannot coexist with the ACE-Step FastAPI in VRAM, so they use the
  // evict-all 'oneshot' tenant (whole-card, no persistent server).
  'ace-tts':           { tenant: 'oneshot'   as const, priority: 25, maxRuntimeMs: 10 * 60 * 1000 },
  'ace-whisper':       { tenant: 'oneshot'   as const, priority: 25, maxRuntimeMs: 20 * 60 * 1000 },
  // audio-separator CLI (BS/Mel-Roformer, Demucs, MDX) — server-side stem
  // extraction for training-data preprocessing. Shares the evict-all
  // 'oneshot' tenant with ace-tts/ace-whisper (same one-shot-python shape);
  // it's a distinct task type so its own maxRuntimeMs (a full dataset can
  // take a while) doesn't have to match Whisper's.
  'ace-stem-separate': { tenant: 'oneshot'   as const, priority: 25, maxRuntimeMs: 30 * 60 * 1000 },
  // maxRuntimeMs: 0 => uncapped (long-running training jobs; the watchdog
  // only guards against leaked slots, not real work durations).
  // ace-train runs through the ACE-Step FastAPI (preprocess/init/train REST
  // routes), so it stays on the 'ace-step' tenant (FastAPI resident).
  'ace-train':         { tenant: 'ace-step'  as const, priority: 30, maxRuntimeMs: 0 },
  'image-lora-train':  { tenant: 'oneshot'   as const, priority: 30, maxRuntimeMs: 0 },
} as const;

export type TaskType = keyof typeof TASK_TYPES;
// 'oneshot' = any evict-all exclusive one-shot GPU job with no persistent
// server (image-LoRA training, TTS, Whisper).
export type GpuTenant = 'ollama' | 'comfy' | 'ace-step' | 'oneshot' | 'none';
