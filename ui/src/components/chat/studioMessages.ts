// Bridge types + converters between Studio's persisted `ChatMessage` shape
// and the Vercel AI SDK `UIMessage` shape that `useChat` operates on.
//
// Why this lives here:
// * `useChat` is parameterised over `UIMessage<METADATA, DATA_PARTS, TOOLS>`.
//   Studio's persisted messages carry telemetry columns (tokens_per_sec,
//   ms_total, model, ...) that don't have a slot in `UIMessage`; we stash
//   them in `metadata` so `<TelemetryFooter>` can read them off any message
//   (streamed or rehydrated) without a sidecar lookup.
// * Studio also persists `file-meta` parts (text-file attachment chips that
//   carry no content, only filename/size). Those don't exist in the
//   `UIMessagePart` union, so we surface them as the typed data part
//   `data-fileMeta`.
// * Tool invocations are surfaced as `dynamic-tool` parts (Studio doesn't
//   ship a typed tool registry on the client; the bus emits a name + args).

import type { UIMessage } from 'ai';
import type { ChatMessage, ChatUIMessagePart } from '../../services/comfyui';

/** Studio's per-message telemetry — populated from `chat:done` stats or
 *  rehydrated from the persisted columns when the conversation reloads. */
export interface StudioMetadata {
  tokens_in?: number | null;
  tokens_out?: number | null;
  ms_to_first_token?: number | null;
  ms_total?: number | null;
  tokens_per_sec?: number | null;
  model?: string | null;
  created_at?: number;
  conversationId?: string;
}

/** Custom data parts so attachment metadata round-trips cleanly through
 *  `useChat`'s `parts` array without resorting to ad-hoc fields. Declared
 *  as a `type` (not `interface`) so TS treats it as structurally
 *  satisfying the `UIDataTypes = Record<string, unknown>` constraint —
 *  interfaces don't get an implicit index signature, plain object types do. */
export type StudioDataParts = {
  fileMeta: { filename: string; size?: number; mediaType?: string };
};

export type StudioUIMessage = UIMessage<StudioMetadata, StudioDataParts>;
export type StudioUIMessagePart = StudioUIMessage['parts'][number];

/** Convert one persisted part into a `StudioUIMessage` part. Anything the
 *  server sent that we don't recognise becomes a `text` part (best-effort
 *  fallback so a stray legacy shape doesn't drop the message). */
export function persistedPartToUIPart(part: ChatUIMessagePart): StudioUIMessagePart | null {
  if (part.type === 'text') {
    return { type: 'text', text: part.text ?? '' };
  }
  if (part.type === 'reasoning') {
    return { type: 'reasoning', text: part.text ?? '' };
  }
  if (part.type === 'file' && typeof part.url === 'string') {
    return {
      type: 'file',
      mediaType: part.mediaType ?? 'application/octet-stream',
      url: part.url,
      filename: part.name,
    };
  }
  if (part.type === 'file-meta') {
    return {
      type: 'data-fileMeta',
      data: {
        filename: part.name ?? 'file',
        size: part.size,
        mediaType: part.mediaType,
      },
    };
  }
  if (part.type === 'tool-invocation') {
    // Persisted shape (see server `toolDispatch.ts`):
    //   { type: 'tool-invocation', toolCallId, toolName, args, state, result?, errorMessage? }
    const p = part as unknown as {
      toolCallId: string; toolName: string;
      args: unknown;
      state: 'result' | 'error';
      result?: unknown;
      errorMessage?: string;
    };
    if (p.state === 'error') {
      return {
        type: 'dynamic-tool',
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        state: 'output-error',
        input: p.args,
        errorText: p.errorMessage ?? 'Unknown error',
      };
    }
    return {
      type: 'dynamic-tool',
      toolName: p.toolName,
      toolCallId: p.toolCallId,
      state: 'output-available',
      input: p.args,
      output: p.result,
    };
  }
  return null;
}

export function chatMessageToUIMessage(m: ChatMessage): StudioUIMessage {
  const parts: StudioUIMessagePart[] = [];
  for (const p of m.parts) {
    const conv = persistedPartToUIPart(p);
    if (conv) parts.push(conv);
  }
  // Empty assistant messages still need a placeholder text part so renderers
  // that look for `text` don't crash on edge cases. User messages always have
  // at least one part (text or attachment) so the empty branch is rare.
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return {
    id: m.id,
    role: m.role,
    parts,
    metadata: {
      tokens_in: m.tokens_in,
      tokens_out: m.tokens_out,
      ms_to_first_token: m.ms_to_first_token,
      ms_total: m.ms_total,
      tokens_per_sec: m.tokens_per_sec,
      model: m.model,
      created_at: m.created_at,
      conversationId: m.conversationId,
    },
  };
}

/** Build a user message in the `UIMessage` shape from the typed prompt + the
 *  pending attachments. Mirrors `attachments.buildUserMessageParts`, but
 *  emits `data-fileMeta` instead of the legacy `file-meta` part.
 *  `kind` is the broader `AttachmentKind` ('image' | 'text' | 'pdf' |
 *  'unsupported') because that's what `PendingAttachment` carries; the
 *  composer already gates so only image / text actually reach this path,
 *  but we tolerate the wider union to avoid a cast at the call site. */
export function buildUserUIMessageParts(
  prompt: string,
  attachments: ReadonlyArray<{
    id: string;
    kind: 'image' | 'text' | 'pdf' | 'unsupported';
    filename: string;
    size: number;
    mimeType: string;
    dataUrl?: string;
    textContent?: string;
  }>,
  formatBytes: (n: number) => string,
): StudioUIMessagePart[] {
  const textBlocks: string[] = [];
  for (const a of attachments) {
    if (a.kind === 'text' && a.textContent !== undefined) {
      textBlocks.push(
        `[Attached file: ${a.filename} (${formatBytes(a.size)})]\n---\n${a.textContent}\n---`,
      );
    }
  }
  if (prompt.trim().length > 0) textBlocks.push(prompt);
  const parts: StudioUIMessagePart[] = [];
  const combined = textBlocks.join('\n\n');
  if (combined.length > 0) parts.push({ type: 'text', text: combined });
  for (const a of attachments) {
    if (a.kind === 'image' && a.dataUrl) {
      parts.push({
        type: 'file',
        mediaType: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      });
    }
    if (a.kind === 'text') {
      parts.push({
        type: 'data-fileMeta',
        data: { filename: a.filename, size: a.size, mediaType: a.mimeType },
      });
    }
  }
  return parts;
}

/** Convert a `StudioUIMessage` back into the wire shape `/chat/start`
 *  expects (matches the server's `chatStartSchema` — `id`, `role`, `parts`).
 *  We strip the `data-fileMeta` data parts because they only exist for the
 *  client-side attachment chip; the server already inlined the file content
 *  into the preceding text block when the message was built. */
export function uiMessageToWire(m: StudioUIMessage): {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: ChatUIMessagePart[];
} {
  const parts: ChatUIMessagePart[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') {
      parts.push({ type: 'text', text: p.text });
    } else if (p.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: p.text });
    } else if (p.type === 'file') {
      parts.push({
        type: 'file',
        mediaType: p.mediaType,
        url: p.url,
        ...(p.filename ? { name: p.filename } : {}),
      });
    } else if (p.type === 'data-fileMeta') {
      // Persist as the legacy `file-meta` shape the server already understands.
      parts.push({
        type: 'file-meta',
        name: p.data.filename,
        size: p.data.size,
        mediaType: p.data.mediaType,
      });
    } else if (p.type === 'dynamic-tool') {
      // Round-trip a persisted tool invocation. New tool invocations created
      // by the server during streaming go straight into `chat_messages.parts`
      // server-side — this branch only fires when a regenerate / edit replays
      // an earlier message that already carried tool parts.
      const wire: Record<string, unknown> = {
        type: 'tool-invocation',
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.input,
      };
      if (p.state === 'output-error') {
        wire.state = 'error';
        wire.errorMessage = p.errorText;
      } else if (p.state === 'output-available') {
        wire.state = 'result';
        wire.result = p.output;
      }
      parts.push(wire as unknown as ChatUIMessagePart);
    }
    // step-start, source-*, dynamic data parts other than fileMeta — drop on
    // the wire. They aren't part of Studio's persisted schema.
  }
  return { id: m.id, role: m.role, parts };
}
