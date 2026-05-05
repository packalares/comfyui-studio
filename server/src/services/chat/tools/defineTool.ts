// Studio's thin wrapper around the AI-SDK `tool()` factory. Adds a single
// extra metadata field (`unloadGpuOnUse`) consumed by the GPU orchestrator
// just before each tool dispatch.
//
// Why a wrapper instead of stuffing the flag onto the AI-SDK tool record:
// the AI-SDK `Tool` type is structural and round-trips through `streamText`
// / `toOllamaTools` — extra fields aren't part of its contract, so a future
// SDK upgrade could drop or rename them. Keeping our metadata in a sibling
// field avoids that risk and gives the orchestrator a typed handle.

import { tool, type Tool } from 'ai';

/**
 * Studio's tool descriptor — AI-SDK tool plus Studio-specific metadata.
 * `tool` is exactly what `streamText` / `toOllamaTools` / `executeOllamaToolCall`
 * expect; `unloadGpuOnUse` is consumed only by the GPU orchestrator.
 *
 * The wrapped `Tool` is widened to `Tool<any, any>` on the map type because
 * `Tool<INPUT, OUTPUT>` is invariant in INPUT (via `ToolNeedsApprovalFunction`)
 * — heterogeneous tool maps would otherwise reject a `Tool<{prompt}>` next to
 * a `Tool<{query}>`. Concrete typing is preserved on each `defineTool()` call
 * via the function's generic; only the registry erases it.
 */
// `any` here is load-bearing: the AI-SDK `Tool<INPUT, OUTPUT>` is invariant in
// INPUT, so `unknown` would refuse heterogeneous tool maps. Concrete typing is
// preserved on each `defineTool()` call site via the function's generics.
export interface StudioTool<INPUT = any, OUTPUT = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The wrapped AI-SDK tool — what streamText / runToolDispatch consume. */
  tool: Tool<INPUT, OUTPUT>;
  /** When `true`, the GPU orchestrator unloads Ollama before this tool runs.
   *  Default `false` — only opt in if the tool needs GPU exclusivity (e.g.
   *  ComfyUI image generation that would otherwise OOM next to a loaded LLM). */
  unloadGpuOnUse: boolean;
}

/**
 * Define a Studio chat tool. Mirrors the `tool()` signature so existing
 * `description` / `inputSchema` / `execute` typings flow through unchanged;
 * the only new key is `unloadGpuOnUse` which defaults to `false`.
 */
export function defineTool<INPUT, OUTPUT>(
  opts: Tool<INPUT, OUTPUT> & { unloadGpuOnUse?: boolean },
): StudioTool<INPUT, OUTPUT> {
  const { unloadGpuOnUse, ...toolOpts } = opts;
  return {
    tool: tool(toolOpts as Tool<INPUT, OUTPUT>),
    unloadGpuOnUse: unloadGpuOnUse ?? false,
  };
}
