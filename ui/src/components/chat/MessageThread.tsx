// Conversation thread, ai-elements rebuild.
//
// Responsibilities (unchanged from the hand-rolled version):
//   * render persisted messages + the in-flight assistant message;
//   * surface the streaming "thinking" indicator + "loading model into VRAM"
//     hint and a sticky stream-error banner;
//   * own the drag-drop overlay that hands files up to the parent (composer
//     keeps the canonical attachment list);
//   * render the image lightbox triggered from user-attached image chips.
//
// The visual primitives now come from `components/ai-elements/*`:
//   * <Conversation> (use-stick-to-bottom) replaces our manual scroll glue;
//   * <Message> + <MessageContent> + <MessageResponse> (streamdown markdown)
//     replace MarkdownMessage and the per-row layout;
//   * <Tool> replaces ToolBlock (tool args/result + status);
//   * <Reasoning> (Studio adapter, fed by chat:reasoning bus) renders the
//     model's chain-of-thought above the regular text.
//
// We KEEP the <details>-like envelope for assistant rows so persisted reasoning
// (`{ type: 'reasoning' }` parts saved by streamChat.ts) still re-renders
// after a refetch.

import { useEffect, useState } from 'react';
import { AlertCircle, FileText, Upload, X, MessageSquare } from 'lucide-react';
import {
  Conversation, ConversationContent, ConversationScrollButton,
} from '../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../ai-elements/message';
import {
  Tool, ToolHeader, ToolContent, ToolInput, ToolOutput,
} from '../ai-elements/tool';
import { Loader } from '../ai-elements/loader';
import Reasoning from './Reasoning';
import Actions from './Actions';
import TelemetryFooter from './TelemetryFooter';
import type { ChatMessage, ChatUIMessagePart } from '../../services/comfyui';
import type { ChatToolPart } from '../../services/chatEvents';
import { formatBytes } from './attachments';

interface ImageAttachment { kind: 'image'; url: string; mediaType?: string; name?: string; size?: number }
interface FileAttachment { kind: 'file'; name: string; size?: number; mediaType?: string }
type RenderedAttachment = ImageAttachment | FileAttachment;

interface Props {
  messages: ChatMessage[];
  streamingMsgId: string | null;
  streamingText: string;
  // Inline "loading model into VRAM..." hint emitted by the server.
  streamStatus: string;
  // Last stream error (kept until next send).
  streamError: string;
  busy: boolean;
  hasConversation: boolean;
  streamingTools?: ChatToolPart[];
  // Drag-drop callback up to the parent composer.
  onFilesDropped?: (files: FileList) => void;
}

function partsToText(parts: ChatUIMessagePart[]): string {
  return parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
}

function partsToReasoning(parts: ChatUIMessagePart[]): string {
  return parts.filter(p => p.type === 'reasoning').map(p => p.text ?? '').join('');
}

function attachmentsOf(parts: ChatUIMessagePart[]): RenderedAttachment[] {
  const out: RenderedAttachment[] = [];
  for (const p of parts) {
    if (p.type === 'file' && typeof p.url === 'string'
        && (p.mediaType?.startsWith('image/') ?? false)) {
      out.push({
        kind: 'image', url: p.url, mediaType: p.mediaType, name: p.name, size: p.size,
      });
    } else if (p.type === 'file-meta') {
      out.push({
        kind: 'file', name: p.name ?? 'file', size: p.size, mediaType: p.mediaType,
      });
    }
  }
  return out;
}

function isToolPart(value: unknown): value is ChatToolPart {
  if (!value || typeof value !== 'object') return false;
  const p = value as { type?: unknown; toolName?: unknown };
  return p.type === 'tool-invocation' && typeof p.toolName === 'string';
}

function toolPartsOf(parts: ChatUIMessagePart[]): ChatToolPart[] {
  const out: ChatToolPart[] = [];
  for (const p of parts) if (isToolPart(p)) out.push(p);
  return out;
}

export default function MessageThread({
  messages, streamingMsgId, streamingText, streamStatus, streamError, busy, hasConversation,
  streamingTools, onFilesDropped,
}: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(null); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [zoomed]);

  // Show the streaming indicator only while the assistant placeholder is up
  // but no chunk has streamed yet, OR while we're waiting for /chat/start.
  const showStreamingHint =
    (streamingMsgId !== null && streamingText.length === 0)
    || (busy && streamingMsgId === null);

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
          {!hasConversation && !busy && (
            <div className="empty-box flex flex-col items-center gap-1.5 py-12">
              <MessageSquare className="h-6 w-6 text-slate-300" />
              <div className="text-sm font-medium text-slate-600">Start a new conversation</div>
              <div className="text-xs text-slate-500">Type below or pick one from the sidebar.</div>
            </div>
          )}
          {hasConversation && messages.length === 0 && !busy && (
            <div className="empty-box py-12">
              Start a conversation by typing a message below.
            </div>
          )}
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              isStreaming={m.id === streamingMsgId}
              streamingText={m.id === streamingMsgId ? streamingText : null}
              streamingTools={m.id === streamingMsgId ? (streamingTools ?? []) : null}
              streamStatus={streamStatus}
              onZoom={setZoomed}
            />
          ))}
          {showStreamingHint && !messages.some(m => m.id === streamingMsgId) && (
            <Message from="assistant">
              <MessageContent>
                <Loader status={streamStatus} />
              </MessageContent>
            </Message>
          )}
          {streamError && !busy && (
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
  msg: ChatMessage;
  isStreaming: boolean;
  streamingText: string | null;
  streamingTools: ChatToolPart[] | null;
  streamStatus: string;
  onZoom: (url: string) => void;
}

function MessageRow({ msg, isStreaming, streamingText, streamingTools, streamStatus, onZoom }: RowProps) {
  const isUser = msg.role === 'user';
  const text = isStreaming
    ? (streamingText ?? '')
    : partsToText(msg.parts);
  const reasoningText = isStreaming ? '' : partsToReasoning(msg.parts);
  const tools = isStreaming
    ? (streamingTools ?? [])
    : toolPartsOf(msg.parts);
  const atts = isUser ? attachmentsOf(msg.parts) : [];

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
            {/* Persisted reasoning re-render. Live reasoning rides on the
                streaming sibling below. */}
            {!isStreaming && reasoningText.length > 0 && (
              <Reasoning text={reasoningText} />
            )}
            {isStreaming && <Reasoning streamingMsgId={msg.id} />}
            {tools.map((t) => (
              <ToolBlockCard key={t.toolCallId} part={t} />
            ))}
            {isStreaming && text.length === 0
              ? <Loader status={streamStatus} />
              : <MessageResponse>{text || ' '}</MessageResponse>}
            {!isStreaming && (
              <>
                <TelemetryFooter
                  model={msg.model}
                  tokensPerSec={msg.tokens_per_sec}
                  msTotal={msg.ms_total}
                  msToFirstToken={msg.ms_to_first_token}
                  tokensIn={msg.tokens_in}
                  tokensOut={msg.tokens_out}
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

// Map our persisted ChatToolPart shape onto ai-elements' <Tool>. Studio's tool
// records carry `state: 'result' | 'error'` (terminal only — we don't surface
// the in-flight `running` state yet) and string `errorMessage`; ai-elements
// expects `output-available` / `output-error` and `errorText`. The mapping is
// trivial but kept here so we don't need to leak ai-elements types out to the
// chatEvents bus.
function ToolBlockCard({ part }: { part: ChatToolPart }) {
  const state = part.state === 'error' ? 'output-error' : 'output-available';
  return (
    <Tool>
      <ToolHeader
        type={`tool-${part.toolName}` as `tool-${string}`}
        state={state}
      />
      <ToolContent>
        <ToolInput input={part.args} />
        <ToolOutput
          output={part.state === 'error' ? null : part.result}
          errorText={part.state === 'error' ? (part.errorMessage ?? 'Unknown error') : undefined}
        />
      </ToolContent>
    </Tool>
  );
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
