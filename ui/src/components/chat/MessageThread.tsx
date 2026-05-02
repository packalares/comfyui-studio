import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { User, Bot, ArrowDown, AlertCircle, MessageSquare, FileText, Upload, X } from 'lucide-react';
import MarkdownMessage from './MarkdownMessage';
import TelemetryFooter from './TelemetryFooter';
import ToolBlock, { isToolPart } from './ToolBlock';
import type { ChatMessage, ChatUIMessagePart } from '../../services/comfyui';
import type { ChatToolPart } from '../../services/chatEvents';
import { formatBytes } from './attachments';

// Pull tool-invocation parts out of a message. Unknown part shapes are ignored
// so the renderer stays forward-compat when the server emits new types.
function toolPartsOf(parts: ChatMessage['parts']): ChatToolPart[] {
  const out: ChatToolPart[] = [];
  for (const p of parts) if (isToolPart(p)) out.push(p);
  return out;
}

interface ImageAttachment { kind: 'image'; url: string; mediaType?: string; name?: string; size?: number }
interface FileAttachment { kind: 'file'; name: string; size?: number; mediaType?: string }
type RenderedAttachment = ImageAttachment | FileAttachment;

function attachmentsOf(parts: ChatMessage['parts']): RenderedAttachment[] {
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

interface Props {
  messages: ChatMessage[];
  streamingMsgId: string | null;
  streamingText: string;
  // Inline "loading model into VRAM..." hint emitted by the server when the
  // first token is taking long. Empty string when there's no hint to show.
  streamStatus: string;
  // Last stream error (kept until next send) so the failure stays visible
  // even after sonner's toast has dismissed.
  streamError: string;
  busy: boolean;
  // Whether a conversation has been selected / started — drives the empty
  // state when neither is true.
  hasConversation: boolean;
  streamingTools?: ChatToolPart[];
  // Drag-drop callbacks routed up to the parent Chat page so the composer's
  // attachment list owns the dropped files (no duplicated state).
  onFilesDropped?: (files: FileList) => void;
}

function partsToText(parts: ChatMessage['parts']): string {
  return parts
    .filter(p => p.type === 'text')
    .map(p => p.text ?? '')
    .join('');
}

const AUTO_SCROLL_THRESHOLD = 80;

export default function MessageThread({
  messages, streamingMsgId, streamingText, streamStatus, streamError, busy, hasConversation,
  streamingTools, onFilesDropped,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  // Lightboxed image (full-size view). Cleared on backdrop click or Esc.
  const [zoomed, setZoomed] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuckToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, streamStatus, stuckToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuckToBottom(distance < AUTO_SCROLL_THRESHOLD);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, []);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(null); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [zoomed]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStuckToBottom(true);
  };

  // Single consolidated thinking indicator: shown ONLY while the assistant
  // row exists and no chunk has streamed yet, OR while we're waiting for the
  // /chat/start round-trip (busy=true but msgId not yet set). Replaces the
  // previous duplicated showThinking + in-message banner pair.
  const showStreamingHint =
    (streamingMsgId !== null && streamingText.length === 0)
    || (busy && streamingMsgId === null);

  return (
    <div
      className="relative flex-1 min-h-0"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
        }
      }}
      onDragLeave={(e) => {
        // Only deactivate when leaving the outer container, not a child node.
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
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
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
          {messages.map((m) => {
            const text = m.id === streamingMsgId
              ? streamingText
              : partsToText(m.parts);
            const isUser = m.role === 'user';
            const isStreaming = m.id === streamingMsgId;
            const tools = isStreaming
              ? (streamingTools ?? [])
              : toolPartsOf(m.parts);
            const atts = isUser ? attachmentsOf(m.parts) : [];
            return (
              <div key={m.id} className="flex gap-3">
                <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  isUser ? 'bg-slate-100 text-slate-700' : 'bg-teal-50 text-teal-700 ring-1 ring-teal-100'
                }`}>
                  {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  {isUser ? (
                    <>
                      {atts.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-2">
                          {atts.map((a, i) => (
                            <RenderedAttachmentChip
                              key={i}
                              att={a}
                              onZoom={() => a.kind === 'image' && setZoomed(a.url)}
                            />
                          ))}
                        </div>
                      )}
                      {text.length > 0 && (
                        <div className="whitespace-pre-wrap text-sm text-slate-800">{text}</div>
                      )}
                    </>
                  ) : (
                    <>
                      {tools.map((t) => (
                        <ToolBlock key={t.toolCallId} part={t} />
                      ))}
                      {isStreaming && text.length === 0 ? (
                        <StreamingHint message={streamStatus} />
                      ) : (
                        <MarkdownMessage text={text || ' '} />
                      )}
                      {m.role === 'assistant' && !isStreaming && (
                        <TelemetryFooter
                          model={m.model}
                          tokensPerSec={m.tokens_per_sec}
                          msTotal={m.ms_total}
                          msToFirstToken={m.ms_to_first_token}
                          tokensIn={m.tokens_in}
                          tokensOut={m.tokens_out}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {/* No standalone thinking row — the in-flight assistant message
              renders the indicator on its own placeholder above. We only need
              this fallback when the assistant placeholder somehow isn't in
              messages yet (very early in submit, before /chat/start resolves
              and inserts the row). */}
          {showStreamingHint && !messages.some(m => m.id === streamingMsgId) && (
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700 ring-1 ring-teal-100">
                <Bot className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <StreamingHint message={streamStatus} />
              </div>
            </div>
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
        </div>
      </div>
      <JumpToBottom show={!stuckToBottom} onClick={jumpToBottom} />
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

interface HintProps { message: string }
function StreamingHint({ message }: HintProps) {
  // One indicator unifies "Sending" / "Loading model into VRAM" / "warming
  // up" — the message string toggles between defaults and the server-pushed
  // `chat:status` text. Animation stays the same so the visual stays calm.
  const label = message || 'Thinking...';
  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
      <span className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
      </span>
      <span>{label}</span>
    </div>
  );
}

interface JumpProps { show: boolean; onClick: () => void }
function JumpToBottom({ show, onClick }: JumpProps) {
  if (!show) return null;
  return (
    <button
      onClick={onClick}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 px-3 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50"
      aria-label="Jump to latest"
    >
      <ArrowDown className="h-3 w-3" />
      Jump to latest
    </button>
  );
}

