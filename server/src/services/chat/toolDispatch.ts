// Multi-step tool-dispatch loop for the Ollama chat path. Splits the loop out
// of `streamChat.ts` so the parent file stays under the 250-line cap and so
// the dispatcher can be unit-tested with stubbed `runStep` / `executeToolCall`
// callbacks.
//
// The loop terminates when either:
//   - the assistant frame has zero `tool_calls` (final answer reached)
//   - we hit `maxSteps` (safety cap against runaway loops)
//   - any unrecoverable error bubbles from `runStep`

import type { OllamaChatMessage, OllamaFinalFrame } from './ollamaChat.js';
import type { OllamaToolCall, OllamaToolDef } from './ollamaTools.js';
import { TOOL_ERROR_REPROMPT } from './prompts.js';

/**
 * Persisted-on-message-row representation of one tool turn. Mirrors the
 * Vercel AI SDK's `tool-invocation` part for forward compatibility, but uses
 * the tighter shape the chat UI actually consumes (state + result).
 */
export interface ToolPart {
  type: 'tool-invocation';
  toolCallId: string;
  toolName: string;
  args: unknown;
  state: 'result' | 'error';
  result?: unknown;
  errorMessage?: string;
}

export interface ToolDispatchInput {
  maxSteps: number;
  enabledTools: Record<string, unknown>;
  ollamaTools: OllamaToolDef[];
  seedMessages: OllamaChatMessage[];
  runStep: (messages: OllamaChatMessage[]) => Promise<{
    accumulated: string;
    finalFrame: OllamaFinalFrame | null;
    toolCalls: OllamaToolCall[];
  }>;
  executeToolCall: (call: OllamaToolCall)
    => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;
  /** GPU-orchestrator hook. Awaited BEFORE each tool dispatch so the unload
   *  completes before ComfyUI starts grabbing VRAM. Awaiting also means a
   *  tool that doesn't opt-in pays nothing — the hook short-circuits to a
   *  resolved Promise. */
  onBeforeTool?: (toolName: string) => Promise<void>;
  onToolPart: (part: ToolPart) => void;
}

export interface ToolDispatchResult {
  finalFrame: OllamaFinalFrame | null;
}

let counter = 0;
function nextCallId(): string {
  counter += 1;
  return `call_${Date.now().toString(36)}_${counter}`;
}

function toContentString(value: unknown): string {
  if (typeof value === 'string') return value;
  // Tools (web_search / rag_search) may return a structured envelope of the
  // shape `{ text, sources?, images? }` so the chat UI can render side-channel
  // citation cards / image previews. The model only needs the human-readable
  // `text`; stripping the side-channels here keeps the in-context tool message
  // identical to the legacy plain-text result, which the model has already
  // been tuned to consume.
  if (value !== null && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

export async function runToolDispatch(input: ToolDispatchInput): Promise<ToolDispatchResult> {
  const messages: OllamaChatMessage[] = [...input.seedMessages];
  let finalFrame: OllamaFinalFrame | null = null;

  for (let step = 0; step < input.maxSteps; step += 1) {
    const stepResult = await input.runStep(messages);
    finalFrame = stepResult.finalFrame ?? finalFrame;

    if (stepResult.toolCalls.length === 0) return { finalFrame };

    // Append the assistant frame that asked for the tools, then each tool
    // result. Matches the OpenAI / Ollama tool-call protocol — without this
    // round trip the next step would lose the model's request context.
    messages.push({
      role: 'assistant',
      content: stepResult.accumulated,
    });

    for (const call of stepResult.toolCalls) {
      const callId = nextCallId();
      // GPU orchestrator gate — fires only if the named tool is registered
      // with `unloadGpuOnUse: true` AND the orchestrator's runtime gates
      // pass (co-located + model loaded). See `gpuOrchestrator.beforeTool`.
      if (input.onBeforeTool) {
        await input.onBeforeTool(call.function.name);
      }
      const exec = await input.executeToolCall(call);
      if (exec.ok) {
        const part: ToolPart = {
          type: 'tool-invocation',
          toolCallId: callId,
          toolName: call.function.name,
          args: call.function.arguments,
          state: 'result',
          result: exec.output,
        };
        input.onToolPart(part);
        messages.push({
          role: 'tool',
          content: toContentString(exec.output),
        });
      } else {
        const part: ToolPart = {
          type: 'tool-invocation',
          toolCallId: callId,
          toolName: call.function.name,
          args: call.function.arguments,
          state: 'error',
          errorMessage: exec.error,
        };
        input.onToolPart(part);
        // Surface the failure to the model verbatim so it can choose to
        // recover (e.g. retry with different args) instead of silently
        // hanging.
        messages.push({
          role: 'tool',
          content: TOOL_ERROR_REPROMPT(exec.error),
        });
      }
    }
  }

  // Loop budget exhausted — return whatever final frame we last saw so the
  // caller's telemetry is still meaningful.
  return { finalFrame };
}
