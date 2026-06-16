// Registry of GPU-bound task types with their tenant affinity and priority.
// Priority: lower number = higher priority, same priority = FIFO.
// tenant 'none' is not routed through the scheduler (no GPU contention).
// maxRuntimeMs: hard ceiling enforced by the scheduler watchdog. After this
// elapses on an active slot the watchdog force-releases (logs warn). Set
// generously per-task; the goal is to break leaks, not bound real work.

export const TASK_TYPES = {
  'llm-chat':       { tenant: 'ollama' as const, priority: 10, maxRuntimeMs: 10 * 60 * 1000 },
  'llm-generate':   { tenant: 'ollama' as const, priority: 10, maxRuntimeMs: 10 * 60 * 1000 },
  'llm-embeddings': { tenant: 'ollama' as const, priority: 10, maxRuntimeMs:  2 * 60 * 1000 },
  'comfy-generate': { tenant: 'comfy'  as const, priority: 20, maxRuntimeMs: 45 * 60 * 1000 },
} as const;

export type TaskType = keyof typeof TASK_TYPES;
export type GpuTenant = 'ollama' | 'comfy' | 'none';
