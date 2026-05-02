// Conversation thread, useChat-driven (Phase E).
//
// Source of truth = the `StudioUIMessage[]` array owned by `useChat`. Every
// message — historical, in-flight, or freshly persisted — is rendered from
// the same `parts` array, so we no longer track a `streamingMsgId` /
// `streamingText` / `streamingTools` sidecar (the previous hand-rolled
// state machine kept those parallel to the persisted-messages list).
//
// Responsibilities (unchanged):
//   * render the conversation;
//   * surface the cold-load "loading model into VRAM..." hint (still on the
//     Studio chat:status bus — no UIMessageChunk type for it);
//   * sticky stream-error banner;
//   * drag-drop overlay (composer keeps the canonical attachment list);
//   * image lightbox triggered from user-attached image chips.
//
// Visual primitives still come from `components/ai-elements/*`. `<Reasoning>`
// is now used directly per-part (no Studio adapter); the Phase D
// `Reasoning.tsx` file was deleted because the bus subscription it owned is
// now done by `StudioTransport` -> `reasoning-delta` chunks -> useChat parts.

import { useEffect, useState } from 'react';
import { AlertCircle, FileText, Upload, X, MessageSquare } from 'lucide-react';
import {
  Conversation, ConversationContent, ConversationScrollButton,
} from '../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../ai-elements/message';
import {
  Tool, ToolHeader, ToolContent, ToolInput, ToolOutput,
} from '../ai-elements/tool';
import {
  Reasoning, ReasoningContent, ReasoningTrigger,
} from '../ai-elements/reasoning';
import { Loader } from '../ai-elements/loader';
import Actions from './Actions';
import TelemetryFooter from './TelemetryFooter';
import { chatEvents } from '../../services/chatEvents';
import { formatBytes } from './attachments';
import type { StudioUIMessage, StudioUIMessagePart } from './studioMessages';

interface ImageAttachment { kind: 'image'; url: string; mediaType?: string; name?: string; size?: number }
interface FileAttachment { kind: 'file'; name: string; size?: number; mediaType?: string }
type RenderedAttachment = ImageAttachment | FileAttachment;

interface Props {
  messages: StudioUIMessage[];
  // useChat status — drives the empty-state / "thinking" branches without
  // requiring a separate `streamingMsgId`.
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  // Last stream error (kept until next send).
  streamError: string;
  hasConversation: boolean;
  onFilesDropped?: (files: FileList) => void;
}

function partsToText(parts: StudioUIMessagePart[]): string {
  return parts.filter(p => p.type === 'text').map(p => p.text).join('');
}

function attachmentsOf(parts: StudioUIMessagePart[]): RenderedAttachment[] {
  const out: RenderedAttachment[] = [];
  for (const p of parts) {
    if (p.type === 'file' && p.mediaType.startsWith('image/')) {
      out.push({
        kind: 'image', url: p.url, mediaType: p.mediaType, name: p.filename,
      });
    } else if (p.type === 'data-fileMeta') {
      out.push({
        kind: 'file', name: p.data.filename, size: p.data.size, mediaType: p.data.mediaType,
      });
    }
  }
  return out;
}

export default function MessageThread({
  messages, status, streamError, hasConversation, onFilesDropped,
}: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(null); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [zoomed]);

  // Identify the in-flight assistant message: while streaming, useChat's
  // last entry is the assistant turn currently receiving chunks. Used to
  // gate the cold-load "thinking..." indicator + the streaming flag we
  // pass into <Reasoning isStreaming>.
  const lastMessage = messages[messages.length - 1];
  const inFlightAssistantId =
    (status === 'streaming' || status === 'submitted')
    && lastMessage?.role === 'assistant'
      ? lastMessage.id
      : null;

  // Show the "loading model into VRAM..." chip while the request is in-flight
  // but no chunks have arrived yet (lastMessage hasn't been pushed yet, or it
  // exists but parts are still empty).
  const lastIsAssistantEmpty =
    lastMessage?.role === 'assistant' && partsToText(lastMessage.parts).length === 0;
  const showColdLoadHint =
    status === 'submitted'
    || (status === 'streaming' && lastIsAssistantEmpty);

  return (
    <div
      className="relative flex-1 min-h-0 flex"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setDragActive(false);
          onFilesDropped?.(e.dataTransfer.files);
        }
      }}
    >
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl px-4 py-6">
          {!hasConversation && status === 'ready' && (
            <div className="empty-box flex flex-col items-center gap-1.5 py-12">
              <MessageSquare className="h-6 w-6 text-slate-300" />
              <div className="text-sm font-medium text-slate-600">Start a new conversation</div>
              <div className="text-xs text-slate-500">Type below or pick one from the sidebar.</div>
            </div>
          )}
          {hasConversation && messages.length === 0 && status === 'ready' && (
            <div className="empty-box py-12">
              Start a conversation by typing a message below.
            </div>
          )}
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              isStreaming={m.id === inFlightAssistantId}
              onZoom={setZoomed}
            />
          ))}
          {showColdLoadHint && lastMessage?.role !== 'assistant' && (
            <Message from="assistant">
              <MessageContent>
                <ColdLoadLoader />
              </MessageContent>
            </Message>
          )}
          {streamError && status === 'ready' && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <div className="font-medium">Stream failed</div>
                <div className="text-rose-700">{streamError}</div>
              </div>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-teal-400 bg-teal-50/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-teal-700">
            <Upload className="h-4 w-4" />
            Drop file here
          </div>
        </div>
      )}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setZoomed(null)}
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 text-white/80 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
          <img src={zoomed} alt="" className="max-h-full max-w-full rounded shadow-xl" />
        </div>
      )}
    </div>
  );
}

interface RowProps {
  msg: StudioUIMessage;
  isStreaming: boolean;
  onZoom: (url: string) => void;
}

function MessageRow({ msg, isStreaming, onZoom }: RowProps) {
  const isUser = msg.role === 'user';
  const text = partsToText(msg.parts);
  const atts = isUser ? attachmentsOf(msg.parts) : [];
  const meta = msg.metadata;

  return (
    <Message from={msg.role}>
      <MessageContent>
        {isUser ? (
          <>
            {atts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {atts.map((a, i) => (
                  <RenderedAttachmentChip
                    key={i}
                    att={a}
                    onZoom={() => a.kind === 'image' && onZoom(a.url)}
                  />
                ))}
              </div>
            )}
            {text.length > 0 && (
              <div className="whitespace-pre-wrap text-sm">{text}</div>
            )}
          </>
        ) : (
          <>
            {/* Render every assistant part in source order so the model's
                interleaved reasoning / tools / text show up where they
                were emitted, not bucketed at the top of the row. */}
            {msg.parts.map((p, i) => renderAssistantPart(p, i, isStreaming))}
            {isStreaming && text.length === 0 && msg.parts.every(p => p.type !== 'reasoning' && p.type !== 'dynamic-tool') && (
              <ColdLoadLoader />
            )}
            {!isStreaming && (
              <>
                <TelemetryFooter
                  model={meta?.model ?? null}
                  tokensPerSec={meta?.tokens_per_sec ?? null}
                  msTotal={meta?.ms_total ?? null}
                  msToFirstToken={meta?.ms_to_first_token ?? null}
                  tokensIn={meta?.tokens_in ?? null}
                  tokensOut={meta?.tokens_out ?? null}
                />
                {text.length > 0 && <Actions text={text} />}
              </>
            )}
          </>
        )}
      </MessageContent>
    </Message>
  );
}

function renderAssistantPart(part: StudioUIMessagePart, key: number, isStreaming: boolean) {
  if (part.type === 'reasoning') {
    // No reasoning produced for this turn -> stay invisible so non-thinking
    // models don't render a stray "Thinking..." chip.
    if (!isStreaming && part.text.length === 0) return null;
    return (
      <Reasoning key={`r-${key}`} className="mb-2" isStreaming={isStreaming && part.state !== 'done'}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === 'dynamic-tool') {
    return <ToolBlockCard key={`t-${part.toolCallId}-${key}`} part={part} />;
  }
  if (part.type === 'text') {
    if (part.text.length === 0 && !isStreaming) return null;
    return <MessageResponse key={`m-${key}`}>{part.text || ' '}</MessageResponse>;
  }
  // Source / file / data parts on assistant messages aren't rendered yet —
  // Phase E intentionally leaves Sources & generated-image rendering to a
  // follow-up (the wire-up bullet in the brief).
  return null;
}

// Map a `dynamic-tool` part onto ai-elements `<Tool>`. The chunk lifecycle in
// `StudioTransport` lands `state` at `output-available` or `output-error`
// (Studio's bus is terminal — no streaming-args / running state today).
type DynamicToolPart = Extract<StudioUIMessagePart, { type: 'dynamic-tool' }>;
function ToolBlockCard({ part }: { part: DynamicToolPart }) {
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        toolName={part.toolName}
        state={part.state}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={part.state === 'output-available' ? part.output : null}
          errorText={part.state === 'output-error' ? part.errorText : undefined}
        />
      </ToolContent>
    </Tool>
  );
}

// "loading model into VRAM..." indicator. The cold-load hint comes from
// Studio's `chat:status` bus (no direct UIMessageChunk type for it) so we
// subscribe locally — same code path as the previous hand-rolled stream.
function ColdLoadLoader() {
  const [status, setStatus] = useState('');
  useEffect(() => {
    const off = chatEvents.onStatus(({ message }) => { setStatus(message); });
    return off;
  }, []);
  return <Loader status={status} />;
}

interface ChipProps { att: RenderedAttachment; onZoom: () => void }
function RenderedAttachmentChip({ att, onZoom }: ChipProps) {
  if (att.kind === 'image') {
    return (
      <button
        type="button"
        onClick={onZoom}
        className="group inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-1 pr-2 text-xs text-slate-700 hover:bg-slate-100"
        title={att.name}
      >
        <img
          src={att.url}
          alt={att.name ?? ''}
          className="h-10 w-10 rounded object-cover ring-1 ring-slate-200"
        />
        <div className="flex flex-col items-start leading-tight">
          {att.name && <span className="font-medium text-slate-800 max-w-[180px] truncate">{att.name}</span>}
          {att.size !== undefined && (
            <span className="text-[10px] text-slate-500">{formatBytes(att.size)}</span>
          )}
        </div>
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
      <FileText className="h-4 w-4 text-slate-400" />
      <div className="flex flex-col leading-tight">
        <span className="font-medium text-slate-800 max-w-[180px] truncate">{att.name}</span>
        {att.size !== undefined && (
          <span className="text-[10px] text-slate-500">{formatBytes(att.size)}</span>
        )}
      </div>
    </div>
  );
}
