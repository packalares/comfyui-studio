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
  // When true, render the verbose <ToolBlockCard> (parameters + raw result
  // JSON) under each tool call. Off by default — for `generate_image` the
  // rendered image already shows up below; the JSON is mostly debug noise.
  showToolDetails?: boolean;
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

// `buildUserUIMessageParts` (studioMessages.ts) inlines text-attachment
// content into the user's text part — this is what the model needs but it
// dumps the whole file into the bubble. Strip the `[Attached file: ...]
// \n---\n<content>\n---` blocks so only the user's actual prompt renders.
// The chip already conveys "I attached this file."
const ATTACHED_FILE_BLOCK_RE = /\[Attached file: [^\]]+\]\n---\n[\s\S]*?\n---\n*/g;

function userVisibleText(text: string): string {
  return text.replace(ATTACHED_FILE_BLOCK_RE, '').trim();
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
  webPreviews, showToolDetails, onSuggestionClick, onRegenerate, onDelete,
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

  // Dynamic follow-up suggestions, keyed by `msgId`. The server's
  // `chat:suggestions` event lands here ~300-500ms after the assistant's
  // main reply finishes (one extra non-streaming /api/chat call). When a
  // row is present, `MessageRow` renders these instead of the static
  // heuristic pills from `deriveSuggestions`. Toggle in Settings → Chat
  // disables the round-trip server-side; in that case the bus event never
  // fires and the static fallback continues.
  const [suggestionsByMsg, setSuggestionsByMsg] = useState<Record<string, string[]>>({});
  useEffect(() => {
    return chatEvents.onSuggestions(({ msgId, suggestions }) => {
      if (!msgId || suggestions.length === 0) return;
      setSuggestionsByMsg(prev => ({ ...prev, [msgId]: suggestions }));
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
              <MessageSquare className="h-6 w-6 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">Start a new conversation</div>
              <div className="text-xs text-muted-foreground">Type below or pick one from the sidebar.</div>
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
                showToolDetails={!!showToolDetails}
                galleryByPrompt={galleryByPrompt}
                dynamicSuggestions={suggestionsByMsg[m.id] ?? null}
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
            <div className="alert-rose text-xs">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <div className="font-medium">Stream failed</div>
                <div className="text-destructive">{streamError}</div>
              </div>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/10 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-brand">
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
  showToolDetails: boolean;
  galleryByPrompt: Record<string, GalleryAddedItem>;
  /** Server-generated suggestions for this row, or null when none have
   *  arrived yet (or the smart-suggestions toggle is off). When present,
   *  these replace the static heuristic pills from `deriveSuggestions`. */
  dynamicSuggestions: string[] | null;
  onZoom: (url: string) => void;
  onSuggestionClick?: (text: string) => void;
  onRegenerate?: () => void;
  onDelete?: (msgId: string) => void;
}

function MessageRow({
  msg, isStreaming, isLastAssistant, webPreviews, showToolDetails, galleryByPrompt,
  dynamicSuggestions,
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
  // Prefer the server-generated suggestions when they've arrived for this
  // row; fall back to the static heuristic so the UI never feels empty
  // while the post-turn LLM call is still in flight (or when the toggle
  // is off). Only the last assistant message renders pills.
  const suggestions = useMemo(() => {
    if (!isLastAssistant || isStreaming) return [];
    if (dynamicSuggestions && dynamicSuggestions.length > 0) return dynamicSuggestions;
    return deriveSuggestions(msg);
  }, [isLastAssistant, isStreaming, msg, dynamicSuggestions]);

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

  // For user rows we split attachments + prose: chips render naked above the
  // bubble (the chip is already its own affordance — wrapping it in
  // bg-secondary px-4 py-3 just adds visual noise), prose still lands in the
  // bubble. Bubble itself only renders when there's actual visible text.
  const visibleUserText = isUser ? userVisibleText(text) : '';
  const showUserBubble = isUser && visibleUserText.length > 0;

  return (
    <Message from={msg.role}>
      {isUser && atts.length > 0 && (
        <div className="flex flex-wrap gap-2 group-[.is-user]:ml-auto group-[.is-user]:justify-end">
          {atts.map((a, i) => (
            <RenderedAttachmentChip
              key={i}
              att={a}
              onZoom={() => a.kind === 'image' && onZoom(a.url)}
            />
          ))}
        </div>
      )}
      {(showUserBubble || !isUser) && (
      <MessageContent>
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm">{visibleUserText}</div>
        ) : (
          <>
            {/* Render every assistant part in source order so the model's
                interleaved reasoning / tools / text show up where they
                were emitted, not bucketed at the top of the row. */}
            {msg.parts.map((p, i) => renderAssistantPart(p, i, isStreaming, showToolDetails))}
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
                  loadDurationMs={meta?.load_duration_ms ?? null}
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
      )}
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
  // Until the gallery WS event lands the image, render a skeleton placeholder
  // sized to the same `max-w-md` × roughly-4:3 box the final image will take,
  // so the layout doesn't jump when the image arrives. `animate-pulse` on the
  // shimmer band gives the standard "loading" affordance; a faint image icon
  // anchors the eye in the centre.
  if (!resolved) {
    return (
      <div
        role="status"
        aria-label={`Generating image (${refData.templateName || 'template'})`}
        // Fixed dimensions — the placeholder must NOT reflow as the
        // assistant's surrounding text streams in and grows the bubble.
        // 24rem × 18rem = 384×288, 4:3, fits comfortably in any bubble
        // width and matches roughly the size the rendered image will land at.
        className="relative mt-2 h-72 w-96 overflow-hidden rounded-lg bg-secondary"
      >
        {/* Diagonal "shine" band sweeping left-to-right — the classic
            content-skeleton affordance (Twitter / YouTube / shadcn). The
            keyframe is defined as `--animate-shimmer` in `index.css`. */}
        <div className="skeleton-shimmer" />
        {/* Centered "Generating image" caption above the shimmer — text
            stays still while the band moves underneath, like a watermark
            on a polished surface. */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-medium text-muted-foreground">Generating image…</span>
        </div>
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
      <div className="mt-2 rounded-md border bg-muted px-3 py-2 text-xs text-foreground">
        Generated <a href={url} className="underline">{resolved.filename}</a> — open the gallery to play it.
      </div>
    );
  }
  return (
    // Bare image inside a stripped <button> — every browser default is
    // explicitly killed (border / outline / focus ring / hover shadow)
    // so nothing draws outside the image's rounded edge. Affordance is
    // limited to `cursor-zoom-in`.
    <button
      type="button"
      onClick={() => onZoom(url)}
      className="mt-2 inline-block cursor-zoom-in border-0 bg-transparent p-0 align-top outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
    >
      <img
        src={url}
        alt={resolved.filename}
        className="block max-h-80 max-w-md rounded-lg object-contain"
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

function renderAssistantPart(part: StudioUIMessagePart, key: number, isStreaming: boolean, showToolDetails: boolean) {
  if (part.type === 'reasoning') {
    // No reasoning produced for this turn -> stay invisible so non-thinking
    // models don't render a stray "Thinking..." chip. Also drop
    // whitespace-only reasoning that legacy rows may have persisted before
    // the server-side trim landed — `\n` / `  ` etc. would otherwise show
    // up as an empty "Thought for a few seconds" panel.
    if (!isStreaming && part.text.trim().length === 0) return null;
    return (
      <Reasoning key={`r-${key}`} className="mb-2" isStreaming={isStreaming && part.state !== 'done'}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === 'dynamic-tool') {
    // Hide the verbose tool card unless the user opted in via the composer
    // toggle. Errors are always shown — silently swallowing a tool failure
    // would leave the user staring at a non-response with no clue why.
    if (!showToolDetails && part.state !== 'output-error') return null;
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
  // Fired by the Auto context strategy just before it runs the
  // destructive Compact (summarize → DELETE all → reseed). Banner
  // explains the 2–6s pause; cleared when the first chunk of the
  // assistant reply arrives or the `chat:compacted` event lands.
  compacting: 'Compacting conversation…',
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
        className="group chat-attachment-chip is-button"
        title={att.name}
      >
        <img
          src={att.url}
          alt={att.name ?? ''}
          className="h-10 w-10 rounded object-cover ring-1 ring-border"
        />
        <div className="flex flex-col items-start leading-tight">
          {att.name && <span className="font-medium text-foreground max-w-[180px] truncate">{att.name}</span>}
          {att.size !== undefined && (
            <span className="text-[10px] text-muted-foreground">{formatBytes(att.size)}</span>
          )}
        </div>
      </button>
    );
  }
  return (
    <div className="chat-attachment-chip">
      <FileText className="h-4 w-4 text-muted-foreground" />
      <div className="flex flex-col leading-tight">
        <span className="font-medium text-foreground max-w-[180px] truncate">{att.name}</span>
        {att.size !== undefined && (
          <span className="text-[10px] text-muted-foreground">{formatBytes(att.size)}</span>
        )}
      </div>
    </div>
  );
}
