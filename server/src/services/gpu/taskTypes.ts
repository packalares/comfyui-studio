// Registry of GPU-bound task types with their tenant affinity and priority.
// Priority: lower number = higher priority, same priority = FIFO.
// tenant 'none' is not routed through the scheduler (no GPU contention).

export const TASK_TYPES = {
  'llm-chat':       { tenant: 'ollama' as const, priority: 10 },
  'llm-generate':   { tenant: 'ollama' as const, priority: 10 },
  'llm-embeddings': { tenant: 'ollama' as const, priority: 10 },
  'comfy-generate': { tenant: 'comfy'  as const, priority: 20 },
} as const;

export type TaskType = keyof typeof TASK_TYPES;
export type GpuTenant = 'ollama' | 'comfy' | 'none';
