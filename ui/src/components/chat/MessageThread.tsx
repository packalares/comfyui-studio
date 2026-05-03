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

import { useEffect, useMemo, useState } from 'react';
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
import { Spinner } from '../ui/spinner';
import { api } from '../../services/comfyui';
import {
  Sources, SourcesContent, SourcesTrigger, Source,
} from '../ai-elements/sources';
import {
  InlineCitation, InlineCitationCard, InlineCitationCardBody,
  InlineCitationCardTrigger, InlineCitationCarousel,
  InlineCitationCarouselContent, InlineCitationCarouselHeader,
  InlineCitationCarouselIndex, InlineCitationCarouselItem,
  InlineCitationCarouselNext, InlineCitationCarouselPrev,
  InlineCitationSource,
} from '../ai-elements/inline-citation';
import { Suggestion, Suggestions } from '../ai-elements/suggestion';
import {
  WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewUrl,
} from '../ai-elements/web-preview';
import Actions from './Actions';
import TelemetryFooter from './TelemetryFooter';
import { chatEvents, type GalleryAddedItem } from '../../services/chatEvents';
import { formatBytes } from './attachments';
import {
  collectToolSources, deriveSuggestions, extractGenerateImageRefs,
  extractInlineUrls, type ToolSourceList,
} from './messageParts';
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
  // When true, plain URLs in assistant text get a <WebPreview> iframe
  // appended underneath the message. Off by default (composer toggle).
  webPreviews?: boolean;
  // Click handler for the static <Suggestion> follow-up buttons under the
  // last assistant message. Sends the suggestion as a fresh user turn.
  onSuggestionClick?: (text: string) => void;
  // Click handler for the per-message Regenerate action. Provided by the
  // page so this component stays decoupled from `useChat`.
  onRegenerate?: () => void;
  // Click handler for the per-message Delete action. Receives the message id.
  onDelete?: (msgId: string) => void;
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
  webPreviews, onSuggestionClick, onRegenerate, onDelete,
}: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);
  // Prompt-id -> resolved gallery item, populated from `gallery:added` WS
  // events keyed by `promptId`. The `generate_image` tool returns a promptId
  // synchronously; the rendered image lands here when ComfyUI finishes the
  // run, and `<GeneratedImage>` swaps from "queued" placeholder to the real
  // `<img>` automatically.
  const [galleryByPrompt, setGalleryByPrompt] = useState<Record<string, GalleryAddedItem>>({});
  useEffect(() => {
    return chatEvents.onGalleryAdded(({ items }) => {
      if (!items.length) return;
      setGalleryByPrompt(prev => {
        const next = { ...prev };
        for (const it of items) {
          // Most-recent item wins per promptId — a multi-output workflow
          // could land several rows under one promptId; the first one fills
          // the slot and we leave it (the gallery page is the canonical
          // multi-output viewer, not the chat thread).
          if (!next[it.promptId]) next[it.promptId] = it;
        }
        return next;
      });
    });
  }, []);

  // Hydrate the gallery cache when a conversation is reloaded. The WS bus
  // only fires while the user is sitting in chat watching a fresh
  // generation; messages persisted from prior sessions still carry the
  // promptId in their tool result, but the rendered image isn't in the
  // local map. Walk the tool-output parts of every message, collect any
  // promptIds we haven't already seen, and ask the server to resolve
  // them in one batch call.
  useEffect(() => {
    const wanted = new Set<string>();
    for (const m of messages) {
      for (const ref of extractGenerateImageRefs(m.parts)) {
        if (ref.promptId && !galleryByPrompt[ref.promptId]) {
          wanted.add(ref.promptId);
        }
      }
    }
    if (wanted.size === 0) return;
    const ids = [...wanted];
    let cancelled = false;
    api.getGalleryByPromptIds(ids)
      .then(({ items }) => {
        if (cancelled) return;
        setGalleryByPrompt(prev => {
          const next = { ...prev };
          for (const it of items) {
            const pid = it.promptId;
            if (typeof pid !== 'string' || pid.length === 0) continue;
            if (!next[pid]) {
              next[pid] = {
                id: it.id,
                promptId: pid,
                url: it.url ?? '',
                filename: it.filename,
                mediaType: it.mediaType,
              };
            }
          }
          return next;
        });
      })
      .catch(() => { /* network blip — placeholders stay; user can refresh */ });
    return () => { cancelled = true; };
  }, [messages, galleryByPrompt]);

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
        <ConversationContent className="mx-auto w-full max-w-4xl px-4 py-6">
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
          {messages.map((m, idx) => {
            const isLastAssistant = m.role === 'assistant'
              && idx === messages.length - 1
              && status === 'ready';
            return (
              <MessageRow
                key={m.id}
                msg={m}
                isStreaming={m.id === inFlightAssistantId}
                isLastAssistant={isLastAssistant}
                webPreviews={!!webPreviews}
                galleryByPrompt={galleryByPrompt}
                onZoom={setZoomed}
                onSuggestionClick={onSuggestionClick}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            );
          })}
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
  isLastAssistant: boolean;
  webPreviews: boolean;
  galleryByPrompt: Record<string, GalleryAddedItem>;
  onZoom: (url: string) => void;
  onSuggestionClick?: (text: string) => void;
  onRegenerate?: () => void;
  onDelete?: (msgId: string) => void;
}

function MessageRow({
  msg, isStreaming, isLastAssistant, webPreviews, galleryByPrompt,
  onZoom, onSuggestionClick, onRegenerate, onDelete,
}: RowProps) {
  const isUser = msg.role === 'user';
  const text = partsToText(msg.parts);
  const atts = isUser ? attachmentsOf(msg.parts) : [];
  const meta = msg.metadata;

  // Source / image / suggestion derivations are pure functions of `parts`,
  // memoised so a streaming-tick on a sibling message doesn't re-walk the
  // arrays for every other row.
  const sourceLists = useMemo(
    () => (isUser ? [] : collectToolSources(msg.parts)),
    [isUser, msg.parts],
  );
  const imageRefs = useMemo(
    () => (isUser ? [] : extractGenerateImageRefs(msg.parts)),
    [isUser, msg.parts],
  );
  const previewUrls = useMemo(
    () => (isUser || !webPreviews || isStreaming ? [] : extractInlineUrls(text)),
    [isUser, webPreviews, isStreaming, text],
  );
  const suggestions = useMemo(
    () => (isLastAssistant && !isStreaming ? deriveSuggestions(msg) : []),
    [isLastAssistant, isStreaming, msg],
  );

  // User-message Actions (delete only) — rendered as a sibling of the bubble
  // so the bubble's padding isn't disturbed by an always-reserved row of
  // hidden buttons. `Message` already adds `group` to its wrapper, so the
  // `group-hover:flex` in Actions reveals on row-hover (anywhere on the
  // Message, not just the icons themselves).
  const userActionsBlock = !isStreaming && onDelete ? (
    <Actions
      text={text}
      onDelete={() => onDelete(msg.id)}
    />
  ) : null;

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
            {/* Sources panel (one per qualifying tool call). Sits as a
                sibling of the <Tool> card — readers see the tool collapse
                + the citation list as separate affordances. */}
            {sourceLists.map(list => (
              <SourcesBlock key={`s-${list.toolCallId}`} list={list} />
            ))}
            {/* Generated images: queued placeholder until `gallery:added`
                resolves the promptId, then the rendered <img>. */}
            {imageRefs.map(ref => (
              <GeneratedImage
                key={`gi-${ref.toolCallId}`}
                refData={ref}
                resolved={galleryByPrompt[ref.promptId]}
                onZoom={onZoom}
              />
            ))}
            {previewUrls.map((url) => (
              <UrlPreviewCard key={`wp-${url}`} url={url} />
            ))}
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
                {suggestions.length > 0 && onSuggestionClick && (
                  <Suggestions className="mt-2">
                    {suggestions.map(s => (
                      <Suggestion
                        key={s}
                        suggestion={s}
                        onClick={(picked) => onSuggestionClick(picked)}
                      />
                    ))}
                  </Suggestions>
                )}
              </>
            )}
          </>
        )}
      </MessageContent>
      {/* Actions row — sibling of <MessageContent> so it doesn't reserve
          space inside the bubble when hidden. `<Message>` adds `group` to
          its wrapper; Actions uses `group-hover:flex` to surface only on
          row hover. Rendered for both user (delete-only) and assistant
          (copy + regenerate + delete). */}
      {isUser ? userActionsBlock : (!isStreaming && (text.length > 0 || onDelete) && (
        <Actions
          text={text}
          onRegenerate={isLastAssistant ? onRegenerate : undefined}
          onDelete={onDelete ? () => onDelete(msg.id) : undefined}
        />
      ))}
    </Message>
  );
}

// `<Sources>` collapse + InlineCitation hover-card carousel for one tool call.
function SourcesBlock({ list }: { list: ToolSourceList }) {
  const titleHint = list.toolName === 'web_search'
    ? 'Web search results'
    : 'Knowledge base chunks';
  return (
    <div className="mt-2">
      <Sources>
        <SourcesTrigger count={list.sources.length}>
          <span className="font-medium">{titleHint}: {list.sources.length}</span>
        </SourcesTrigger>
        <SourcesContent>
          {list.sources.map((s, idx) => (
            <Source
              key={`${list.toolCallId}-${idx}`}
              href={s.url}
              title={s.title}
            />
          ))}
        </SourcesContent>
      </Sources>
      {/* Inline citation hover card so a single-line summary surfaces snippet
          previews on hover without expanding the full Sources collapse. */}
      <InlineCitationCarouselWrap list={list} />
    </div>
  );
}

function InlineCitationCarouselWrap({ list }: { list: ToolSourceList }) {
  // <InlineCitationCardTrigger> parses the first URL via `new URL()` to
  // render the hostname pill. Limit to http(s) URLs so the synthetic
  // `ragflow://` scheme used by rag_search doesn't slip through and end up
  // showing a meaningless "ragflow" hostname. Drops the inline citation
  // rendering entirely when no http(s) URL is available — the full Sources
  // collapse above already covers that case.
  const urls = list.sources
    .map(s => s.url)
    .filter(u => /^https?:\/\//i.test(u));
  if (urls.length === 0) return null;
  return (
    <InlineCitation className="mt-1 inline-flex items-center text-xs text-muted-foreground">
      <InlineCitationCard>
        <InlineCitationCardTrigger sources={urls} />
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselIndex />
              <InlineCitationCarouselNext />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              {list.sources.map((s, idx) => (
                <InlineCitationCarouselItem key={idx}>
                  <InlineCitationSource
                    title={s.title}
                    url={s.url}
                    description={s.snippet}
                  />
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}

interface GeneratedImageProps {
  refData: { toolCallId: string; promptId: string; templateName: string };
  resolved: GalleryAddedItem | undefined;
  onZoom: (url: string) => void;
}
function GeneratedImage({ refData, resolved, onZoom }: GeneratedImageProps) {
  // Until the gallery WS event lands the image, we render a placeholder card
  // so the user sees that something is in flight. ai-elements `<Image>` is a
  // base64 wrapper; we want a real URL render here, so we use a plain <img>
  // wrapped in the same look-and-feel.
  if (!resolved) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <Spinner size="xs" className="text-teal-500" />
        Image generating ({refData.templateName || 'template'})... prompt {refData.promptId.slice(0, 8)}
      </div>
    );
  }
  const url = resolved.url || `/api/gallery/${encodeURIComponent(resolved.id)}/file`;
  // Only display image media types inline. Audio / video would need different
  // controls; the user can always open the gallery for those. Studio's
  // gallery API stores the bare type ("image", "video", "audio"), not a
  // full MIME type, so we match either form. Filename suffix is a safety
  // net for rows that happen to ship without a media type at all.
  const mt = resolved.mediaType ?? '';
  const isImage = mt.startsWith('image')
    || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(resolved.filename);
  if (!isImage) {
    return (
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Generated <a href={url} className="underline">{resolved.filename}</a> — open the gallery to play it.
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onZoom(url)}
      className="mt-2 block overflow-hidden rounded-md border border-slate-200 bg-slate-50 transition-shadow hover:shadow"
    >
      <img
        src={url}
        alt={resolved.filename}
        className="h-auto max-h-64 max-w-full object-contain"
      />
    </button>
  );
}

function UrlPreviewCard({ url }: { url: string }) {
  return (
    <WebPreview defaultUrl={url} className="mt-2 h-72">
      <WebPreviewNavigation>
        <WebPreviewUrl readOnly value={url} />
      </WebPreviewNavigation>
      <WebPreviewBody />
    </WebPreview>
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

// "loading model into VRAM..." indicator. The server emits `chat:status`
// with a `code` ('loading_model'), and the UI maps it to a display string
// here — single source of truth for the phrasing. Legacy callers that
// still send a `message` literal fall through unchanged.
const STATUS_CODE_LABELS: Record<string, string> = {
  loading_model: 'Loading model into VRAM…',
};

function ColdLoadLoader() {
  const [status, setStatus] = useState('');
  useEffect(() => {
    const off = chatEvents.onStatus(({ code, message }) => {
      if (code && STATUS_CODE_LABELS[code]) {
        setStatus(STATUS_CODE_LABELS[code]);
      } else if (message) {
        setStatus(message);
      }
    });
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
