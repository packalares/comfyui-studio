import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useChat } from '@ai-sdk/react';
import PageSubbar from '../components/layout/PageSubbar';
import ConversationList from '../components/chat/ConversationList';
import MessageThread from '../components/chat/MessageThread';
import Composer from '../components/chat/Composer';
import ContextMeter from '../components/chat/ContextMeter';
import ChatSearch from '../components/chat/ChatSearch';
import { Card } from '../components/ui/card';
import {
  api, ApiError, type OllamaInstalledModel,
} from '../services/comfyui';
import { chatEvents } from '../services/chatEvents';
import {
  formatBytes, MAX_ATTACHMENTS, processFile,
  type PendingAttachment,
} from '../components/chat/attachments';
import {
  StudioTransport,
} from '../components/chat/StudioTransport';
import {
  buildUserUIMessageParts, chatMessageToUIMessage,
  type StudioUIMessage,
} from '../components/chat/studioMessages';
import { EMPTY_STATE_PROMPTS } from '../config/chat-suggestions';

// `EMPTY_STATE_PROMPTS` is imported at the top of this file from
// `../config/chat-suggestions` and renders as the empty-state hero pills.

export default function Chat() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  // True until the first installed-models fetch resolves (success or error).
  // The composer shows a skeleton in the model-picker pill during this window
  // so the user never sees a flash of "No models installed" → real model name.
  const [installedLoading, setInstalledLoading] = useState(true);
  const [model, setModel] = useState<string>('');
  const [streamError, setStreamError] = useState<string>('');
  const [listKey, setListKey] = useState(0);
  // 502 from /api/chat/models means Ollama itself is unreachable. Surfaced
  // via a sonner toast (with a Retry action) instead of an inline banner so
  // it doesn't push the conversation panel down on every visit while the
  // service is starting up.
  const [ollamaUnreachable, setOllamaUnreachable] = useState(false);
  // Pending attachments staged in the composer + appended via drag-drop on
  // the thread. Owned here so both children read the same source of truth.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Capabilities map (basename -> ['vision', ...]) sourced from the chat
  // library endpoint. Used by the composer for an authoritative vision
  // check before falling back to the name-pattern heuristic.
  const [libraryCaps, setLibraryCaps] = useState<Record<string, string[]>>({});
  // Opt-in iframe previews for plain URLs in assistant text. Off by default —
  // automatic embedding can feel aggressive and some sites X-Frame-deny which
  // produces a blank iframe. Persisted in localStorage so the toggle sticks.
  const [webPreviews, setWebPreviews] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('chat:webPreviews') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('chat:webPreviews', webPreviews ? '1' : '0');
  }, [webPreviews]);
  // Show the verbose `<ToolBlockCard>` (parameters + raw result JSON) under
  // each tool call. Off by default — for `generate_image` the rendered image
  // already shows up below; the JSON noise is mostly useful for debugging.
  // Persisted so the toggle sticks across reloads.
  const [showToolDetails, setShowToolDetails] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('chat:showToolDetails') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('chat:showToolDetails', showToolDetails ? '1' : '0');
  }, [showToolDetails]);
  // Tools allow-list owned by the composer's <ChatToolsPopover>. `null` means
  // "no filter — every server-configured tool is available", which matches
  // legacy behavior. Persisted in localStorage so the user's selection sticks
  // across reloads (string[] → JSON, null → key absent).
  const [enabledTools, setEnabledTools] = useState<string[] | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem('chat:enabledTools');
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
    } catch { return null; }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (enabledTools === null) window.localStorage.removeItem('chat:enabledTools');
    else window.localStorage.setItem('chat:enabledTools', JSON.stringify(enabledTools));
  }, [enabledTools]);
  const composerFocusRef = useRef<() => void>(() => {});

  // Refs used by `StudioTransport` so the transport always reads the latest
  // conversationId / model without forcing a recreate on every change. The
  // page-state setters update the refs synchronously below.
  const conversationIdRef = useRef<string | null>(null);
  const modelRef = useRef<string>('');
  const enabledToolsRef = useRef<string[] | null>(null);
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { enabledToolsRef.current = enabledTools; }, [enabledTools]);

  // useChat owns: messages, status, stop, regenerate, setMessages.
  // Transport bridges to Studio's POST /chat/start + chatEvents bus.
  const transport = useMemo(() => new StudioTransport({
    conversationIdRef,
    modelRef,
    enabledToolsRef,
    onConversationStarted: (cid) => {
      // First send in a new conversation - server minted the id; surface it
      // up to the page state + sidebar refresh.
      if (conversationIdRef.current !== cid) {
        conversationIdRef.current = cid;
        setConversationId(cid);
        setListKey(k => k + 1);
      }
    },
  }), []);

  const {
    messages, sendMessage, status, stop, setMessages, regenerate,
  } = useChat<StudioUIMessage>({
    transport,
    onError: (err) => {
      const text = err instanceof Error ? err.message : String(err);
      toast.error('Chat stream failed', { description: text });
      setStreamError(text);
    },
    onFinish: () => {
      // Bump the conversation list so titles / updated_at refresh.
      setListKey(k => k + 1);
    },
  });

  useEffect(() => {
    api.getSystemStats()
      .then(s => { if (s.chat?.defaultModel) setModel(s.chat.defaultModel); })
      .catch(() => { /* picker shows installed list */ });
  }, []);

  useEffect(() => {
    // Best-effort. The library endpoint may be slow / unreachable when the
    // upstream catalog is down — we just fall through to the heuristic.
    api.chat.listLibrary()
      .then(({ items }) => {
        const map: Record<string, string[]> = {};
        for (const m of items) map[m.name] = m.capabilities;
        setLibraryCaps(map);
      })
      .catch(() => { /* heuristic fallback in attachments.ts */ });
  }, []);

  const refreshInstalled = useCallback(() => {
    setInstalledLoading(true);
    // Minimum 400ms hold on the loading state so the composer skeleton is
    // actually perceivable — local Ollama replies in ~20ms otherwise and
    // the skeleton flashes for one frame, which reads as "nothing
    // happened". The hold is enforced via a timestamp diff in `finally`
    // rather than a debounce on the setter so the network race is still
    // honored (no extra delay when the call genuinely takes longer).
    const startedAt = Date.now();
    const finish = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, 400 - elapsed);
      if (remaining === 0) setInstalledLoading(false);
      else setTimeout(() => setInstalledLoading(false), remaining);
    };
    api.chat.listInstalledModels()
      .then(({ models }) => {
        const list = Array.isArray(models) ? models : [];
        setInstalled(list);
        setOllamaUnreachable(false);
        setModel(prev => {
          if (prev && list.some(m => m.name === prev)) return prev;
          if (list.length > 0) return list[0].name;
          return prev;
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 502) {
          setOllamaUnreachable(true);
        }
        setInstalled([]);
      })
      .finally(finish);
  }, []);

  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  // Background retry while Ollama is unreachable. Re-runs the installed
  // models fetch every 4 seconds; when it succeeds, `setOllamaUnreachable(false)`
  // fires inside `refreshInstalled`'s success branch and the interval is
  // cleared on the next effect pass. Keeps the composer skeleton in lockstep
  // with the actual service state without forcing the user to click Retry.
  useEffect(() => {
    if (!ollamaUnreachable) return;
    const t = setInterval(() => { refreshInstalled(); }, 4000);
    return () => clearInterval(t);
  }, [ollamaUnreachable, refreshInstalled]);

  // Surface the "Ollama unreachable" state as a persistent toast (no
  // auto-dismiss) with a Retry action. Stable `id` lets us replace/dismiss
  // it cleanly when the service comes back. Keeping the layout free of an
  // inline banner means the chat panel doesn't jump down every time the
  // service is briefly starting.
  useEffect(() => {
    const id = 'ollama-unreachable';
    if (ollamaUnreachable) {
      toast.error('Ollama is not reachable', {
        id,
        description: 'Check the URL in Settings and make sure Ollama is running.',
        duration: Number.POSITIVE_INFINITY,
        action: { label: 'Retry', onClick: () => refreshInstalled() },
      });
    } else {
      toast.dismiss(id);
    }
  }, [ollamaUnreachable, refreshInstalled]);

  // Hydrate useChat's messages whenever the user picks a different
  // conversation. `setMessages` is the canonical reset path; we don't switch
  // useChat's internal `id` because that would also reset transport
  // refs / callback wiring.
  //
  // Also snap the model picker to the conversation's saved model so the
  // context meter / next-send goes to the model the user actually used in
  // that chat. Falls through to the current selection when the saved model
  // is no longer installed (the user can pick one manually; we don't want
  // to nag with toasts).
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.chat.getConversation(conversationId),
      api.chat.getMessages(conversationId),
    ])
      .then(([conv, { items }]) => {
        if (cancelled) return;
        setMessages(items.map(chatMessageToUIMessage));
        if (conv.model && installed.some(m => m.name === conv.model)) {
          setModel(conv.model);
        }
      })
      .catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
  }, [conversationId, setMessages, installed]);

  // Auto-title broadcast updates the sidebar without a refetch.
  useEffect(() => {
    return chatEvents.onTitle(() => { setListKey(k => k + 1); });
  }, []);

  // Compact wiped + reseeded the persisted message list — re-hydrate the
  // active thread from the DB so the visible scrollback collapses to the
  // single synthetic system summary. Same path as the conversation-switch
  // hydrate above, just triggered explicitly. Sidebar gets bumped too so
  // the conversation row reflects the new updated_at.
  useEffect(() => {
    return chatEvents.onCompacted((p) => {
      if (p.conversationId !== conversationId) return;
      api.chat.getMessages(conversationId)
        .then(({ items }) => setMessages(items.map(chatMessageToUIMessage)))
        .catch(() => { /* ignore — next conv-switch will rehydrate */ });
      setListKey(k => k + 1);
    });
  }, [conversationId, setMessages]);

  const busy = status === 'submitted' || status === 'streaming';

  const handleSend = (text: string, atts: PendingAttachment[]) => {
    if (busy) return;
    if (!model) {
      toast.error('No model selected');
      return;
    }
    setStreamError('');
    const parts = buildUserUIMessageParts(text, atts, formatBytes);
    if (parts.length === 0) return;
    void sendMessage({ parts });
  };

  const handleFilesDropped = useCallback(async (files: FileList) => {
    const arr = Array.from(files);
    if (attachments.length + arr.length > MAX_ATTACHMENTS) {
      toast.error(`Up to ${MAX_ATTACHMENTS} attachments per message`);
      return;
    }
    const next = [...attachments];
    for (const f of arr) {
      const result = await processFile(f);
      if (!result.ok) {
        toast.error(result.filename, { description: result.reason });
        continue;
      }
      next.push(result.attachment);
    }
    setAttachments(next);
  }, [attachments]);

  const handleStop = useCallback(async () => {
    if (!busy) return;
    // useChat.stop() aborts the AbortController on the active sendMessages
    // request; our transport observes that and POSTs /chat/stop/:msgId.
    await stop();
  }, [busy, stop]);

  const handleNew = () => {
    setConversationId(null);
    setMessages([]);
    setStreamError('');
    setAttachments([]);
  };

  // Click handler for the static <Suggestion> follow-up buttons under the
  // last assistant message. Sends the suggestion as a fresh user turn so
  // it follows the same telemetry / context-meter / autotitle paths as a
  // typed prompt. Suppressed while busy so a stray click can't double-send.
  const handleSuggestion = useCallback((text: string) => {
    if (busy || !model) return;
    const parts = buildUserUIMessageParts(text, [], formatBytes);
    if (parts.length === 0) return;
    void sendMessage({ parts });
  }, [busy, model, sendMessage]);

  // Per-message delete handler. Hits the new
  // `DELETE /api/chat/conversations/:id/messages/:msgId` endpoint then strips
  // the row from useChat's local list — refetching would re-trigger
  // chatMessageToUIMessage and discard any in-flight stream state.
  const handleDelete = useCallback(async (msgId: string) => {
    if (!conversationId) return;
    try {
      await api.chat.deleteMessage(conversationId, msgId);
      setMessages(prev => prev.filter(m => m.id !== msgId));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      toast.error('Delete failed', { description: text });
    }
  }, [conversationId, setMessages]);

  // Cmd/Ctrl+K = focus composer (works from anywhere on the page); Esc =
  // stop streaming. Composer-local Enter / Shift+Enter handling stays where
  // it lives so the textarea can handle multi-line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        composerFocusRef.current();
        return;
      }
      if (e.key === 'Escape' && busy) {
        e.preventDefault();
        void handleStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [busy, handleStop]);

  const hasConversation = conversationId !== null || messages.length > 0;

  return (
    <>
      <PageSubbar
        title="Chat"
        description="Talk to a local LLM via Ollama"
      />
      <div className="page-container">
        {/* Single panel with an internal flex split — same idiom as Studio
            (left aside + right main share one rounded surface, instead of
            two side-by-side panels). */}
        <Card>
          <div className="flex flex-col md:flex-row h-[calc(100vh-9rem)] min-h-0">
            <aside className="w-full md:w-[280px] shrink-0 border-b md:border-b-0 md:border-r border-slate-200 flex flex-col min-h-0">
              <ConversationList
                activeId={conversationId}
                refreshKey={listKey}
                onSelect={setConversationId}
                onNew={handleNew}
              />
            </aside>
            <section className="flex flex-1 min-h-0 flex-col">
              {/* Top bar — global chat search + page tabs + context meter. Renders
                  unconditionally so the layout doesn't shift when the user
                  picks a conversation; the meter shows 0% as a placeholder
                  when there's no usage data yet. */}
              <div className="chat-topbar">
                <ChatSearch onSelect={(id) => setConversationId(id)} />
                <div role="tablist" aria-label="Chat section" className="tab-strip">
                  <button role="tab" aria-selected="true" className="tab-strip-item is-active">
                    <MessageSquare className="w-3 h-3" />
                    Chat
                  </button>
                  <Link to="/models?source=ollama" role="tab" aria-selected="false" className="tab-strip-item">
                    <Boxes className="w-3 h-3" />
                    Models
                  </Link>
                </div>
                <div className="ml-auto">
                  <ContextMeter conversationId={conversationId} model={model} />
                </div>
              </div>
              {hasConversation ? (
                <>
                  <MessageThread
                    messages={messages}
                    status={status}
                    streamError={streamError}
                    hasConversation={hasConversation}
                    onFilesDropped={handleFilesDropped}
                    webPreviews={webPreviews}
                    showToolDetails={showToolDetails}
                    onSuggestionClick={handleSuggestion}
                    onRegenerate={() => { void regenerate(); }}
                    onDelete={handleDelete}
                  />
                  <Composer
                    installed={installed}
                    installedLoading={installedLoading || ollamaUnreachable}
                    model={model}
                    onModelChange={setModel}
                    busy={busy}
                    onSend={handleSend}
                    onStop={handleStop}
                    focusRef={composerFocusRef}
                    libraryCapabilities={libraryCaps}
                    attachments={attachments}
                    onAttachmentsChange={setAttachments}
                    webPreviews={webPreviews}
                    onWebPreviewsChange={setWebPreviews}
                    showToolDetails={showToolDetails}
                    onShowToolDetailsChange={setShowToolDetails}
                    enabledTools={enabledTools}
                    onEnabledToolsChange={setEnabledTools}
                  />
                </>
              ) : (
                /* Empty-state hero: centered headline + composer + suggestion
                   pills. Mirrors ChatGPT's first-run UX. Once the user sends
                   their first message we drop into the standard thread layout
                   above. */
                <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8 overflow-y-auto">
                  <h1 className="text-2xl font-medium text-slate-700">What can I help with?</h1>
                  <div className="w-full max-w-4xl">
                    <Composer
                      centered
                      installed={installed}
                      installedLoading={installedLoading || ollamaUnreachable}
                      model={model}
                      onModelChange={setModel}
                      busy={busy}
                      onSend={handleSend}
                      onStop={handleStop}
                      focusRef={composerFocusRef}
                      libraryCapabilities={libraryCaps}
                      attachments={attachments}
                      onAttachmentsChange={setAttachments}
                      webPreviews={webPreviews}
                      onWebPreviewsChange={setWebPreviews}
                      showToolDetails={showToolDetails}
                      onShowToolDetailsChange={setShowToolDetails}
                      enabledTools={enabledTools}
                      onEnabledToolsChange={setEnabledTools}
                    />
                  </div>
                  <div className="flex flex-wrap justify-center gap-2 max-w-4xl">
                    {EMPTY_STATE_PROMPTS.map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => handleSuggestion(p)}
                        disabled={busy || !model}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </Card>
      </div>
    </>
  );
}
