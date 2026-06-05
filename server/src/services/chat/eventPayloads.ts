// Shared payload types for server-side chat stream events.
// Mirrors the shapes in the Zod contract (chat.contract.ts) as plain TS
// interfaces for use in service code that doesn't import Zod.

export interface ChatChunkPayload { msgId: string; delta: string }
export interface ChatReasoningPayload { msgId: string; delta: string }

export interface ChatToolPart {
  type: 'tool-invocation';
  toolCallId: string;
  toolName: string;
  args: unknown;
  state: 'result' | 'error';
  result?: unknown;
  errorMessage?: string;
}
export interface ChatToolPayload { msgId: string; part: ChatToolPart }

export type ChatStatusCode = 'loading_model' | 'compacting' | 'freeing_gpu' | 'unknown';
export interface ChatStatusPayload {
  msgId: string;
  code?: ChatStatusCode;
  message?: string;
}

export interface ChatDoneStats {
  tokens_in: number | null;
  tokens_out: number | null;
  ms_to_first_token: number | null;
  ms_total: number | null;
  tokens_per_sec: number | null;
  model: string | null;
  load_duration_ms: number | null;
}
export interface ChatUsageState {
  used: number;
  budget: number | null;
  percent: number;
  estimatedNext: number;
  warning: 'green' | 'yellow' | 'red';
  strategy: 'sliding' | 'auto';
  model: string;
  modelMaxCtx: number | null;
  numCtx: number | null;
  thinkMode: 'on' | 'off' | null;
  temperature: number | null;
  format: 'json' | null;
}

export interface ChatDonePayload {
  msgId: string;
  stats: ChatDoneStats;
  usage?: ChatUsageState | null;
}
export interface ChatErrorPayload { msgId: string; error: string }
