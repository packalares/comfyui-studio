// Tool-dispatch unit test focused on the GPU-orchestrator hook ordering.
//
// The dispatcher must `await onBeforeTool(toolName)` BEFORE calling
// `executeToolCall(call)` so a co-located VRAM unload completes before the
// tool starts grabbing the GPU. This test stubs both callbacks with
// observable order tracking and asserts the sequence.

import { describe, expect, it } from 'vitest';
import { runToolDispatch } from '../../../src/services/chat/toolDispatch.js';
import type { OllamaToolCall, OllamaToolDef } from '../../../src/services/chat/ollamaTools.js';
import type { OllamaChatMessage } from '../../../src/services/chat/ollamaChat.js';

describe('runToolDispatch', () => {
  it('awaits onBeforeTool before executeToolCall on each tool dispatch', async () => {
    const order: string[] = [];

    let stepIndex = 0;
    const toolCall: OllamaToolCall = {
      function: { name: 'generate_image', arguments: { prompt: 'hi' } },
    };

    const result = await runToolDispatch({
      maxSteps: 3,
      enabledTools: {},
      ollamaTools: [] as OllamaToolDef[],
      seedMessages: [] as OllamaChatMessage[],
      runStep: async () => {
        stepIndex += 1;
        if (stepIndex === 1) {
          // First step: model asks for the tool.
          return {
            accumulated: '',
            finalFrame: null,
            toolCalls: [toolCall],
          };
        }
        // Second step: model emits a final answer with no tool calls.
        return { accumulated: 'done', finalFrame: null, toolCalls: [] };
      },
      onBeforeTool: async (name) => {
        order.push(`before:${name}`);
        // Simulate a non-trivial unload — make sure executeToolCall waits.
        await new Promise((r) => setTimeout(r, 5));
        order.push(`before-done:${name}`);
      },
      executeToolCall: async (call) => {
        order.push(`exec:${call.function.name}`);
        return { ok: true, output: 'ok' };
      },
      onToolPart: () => { /* ignore */ },
    });

    expect(result).toBeDefined();
    expect(order).toEqual([
      'before:generate_image',
      'before-done:generate_image',
      'exec:generate_image',
    ]);
  });

  it('runs without an onBeforeTool hook (legacy callers omit it)', async () => {
    let stepIndex = 0;
    let executed = false;
    await runToolDispatch({
      maxSteps: 3,
      enabledTools: {},
      ollamaTools: [],
      seedMessages: [],
      runStep: async () => {
        stepIndex += 1;
        if (stepIndex === 1) {
          return {
            accumulated: '',
            finalFrame: null,
            toolCalls: [{ function: { name: 'web_search', arguments: {} } }],
          };
        }
        return { accumulated: 'final', finalFrame: null, toolCalls: [] };
      },
      executeToolCall: async () => { executed = true; return { ok: true, output: 'x' }; },
      onToolPart: () => { /* ignore */ },
    });
    expect(executed).toBe(true);
  });
});
