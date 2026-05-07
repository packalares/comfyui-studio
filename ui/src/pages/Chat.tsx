import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Boxes, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useChat } from '@ai-sdk/react';
import PageSubbar from '../components/layout/PageSubbar';
import ConversationList from '../components/chat/ConversationList';
import MessageThread from '../components/chat/MessageThread';
import Composer from '../components/chat/Composer';
import ContextMeter from '../components/chat/ContextMeter';
import ChatSearch from '../components/chat/ChatSearch';
import { Suggestion } from '../components/ai-elements/suggestion';
import { Card } from '../components/ui/card';
import {
  api, ApiError, type OllamaInstalledModel,
  type ChatContextStrategy, type ChatUsageState,
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
import { useSystem } from '../context/AppContext';

// Pre-chat overrides — collected by the ContextMeter popover before any
// conversation exists. Folded into `api.chat.start` on the first send
// (server applies them to the freshly-created conversation row), then
// cleared so subsequent sends use server-side state.
export interface DraftOverrides {
  contextStrategy?: ChatContextStrategy;
  thinkMode?: 'on' | 'off' | null;
  numCtx?: number | null;
  temperature?: number | null;
  format?: 'json' | null;
  /** Soul (personality) override. null = use the server default soul. */
  soulName?: string | null;
}

// Empty-state pills are read from system context (system.chat.suggestions.emptyState)
// which the server hydrates from server/data/chat/default_prompts.md.

export const LAST_CHAT_KEY = 'chat:lastConversationId';

export default function Chat() {
  // URL is the source of truth for which conversation is active. /chat (no
  // param) means "no active chat" — empty state. /chat/c/:chatId means
  // "this chat is active". Sidebar links + new-chat starts both navigate.
  const { chatId } = useParams<{ chatId?: string }>();
  const navigate = useNavigate();
  const conversationId = chatId ?? null;
  // Empty-state hero pills come from `system.chat.suggestions.emptyState`,
  // populated server-side from `data/chat/default_prompts.md`.
  const { chat: chatSettings } = useSystem();
  const emptyStatePrompts = chatSettings?.suggestions?.emptyState ?? [];
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  // True until the first installed-models fetch resolves (success or error).
  // The composer shows a skeleton in the model-picker pill during this window
  // so the user never sees a flash of "No models installed" → real model name.
  const [installedLoading, setInstalledLoading] = useState(true);
  // Capabilities map derived from the installed list (server attaches
  // `capabilities` per row by joining with the cached ollama_library table).
  // Keyed by base name (`gemma3`, not `gemma3:7b`) to match how downstream
  // consumers look up vision/tools/etc. Empty values omitted so absent ===
  // unknown (the modelIsVisionCapable helper treats missing as no-vision).
  const libraryCaps = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const m of installed) {
      const base = m.name.split(':')[0] ?? m.name;
      if (m.capabilities && m.capabilities.length > 0) map[base] = m.capabilities;
    }
    return map;
  }, [installed]);
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
  // Soul (personality) selection. null = server default. Persisted in
  // localStorage so the user's pick survives page reloads and new-chat
  // sessions. A ref keeps the transport in sync without forcing a recreate.
  const [soulName, setSoulName] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem('studio.chat.soulName');
    return typeof raw === 'string' ? raw : null;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (soulName === null) window.localStorage.removeItem('studio.chat.soulName');
    else window.localStorage.setItem('studio.chat.soulName', soulName);
  }, [soulName]);
  const soulNameRef = useRef<string | null>(soulName);
  useEffect(() => { soulNameRef.current = soulName; }, [soulName]);
  const composerFocusRef = useRef<() => void>(() => {});

  // Pre-chat overrides — written by the ContextMeter popover when no
  // conversation exists yet, then folded into `api.chat.start` on the first
  // send so the new conversation row inherits them. Cleared after the conv
  // is minted (the user's choices now live on the server-side row).
  const [draftOverrides, setDraftOverrides] = useState<DraftOverrides>({});
  const draftOverridesRef = useRef<DraftOverrides>({});
  useEffect(() => { draftOverridesRef.current = draftOverrides; }, [draftOverrides]);

  // /chat (no chatId) → optimistically redirect to the last-opened conversation.
  // If that id was deleted (other tab, another device), the hydrate effect below
  // catches the 404, clears LAST_CHAT_KEY, and bounces back to /chat. Runs once
  // on mount; "New chat" navigates to /chat without a stored id so this no-ops.
  useEffect(() => {
    if (chatId !== undefined) return;
    if (typeof window === 'undefined') return;
    const last = window.localStorage.getItem(LAST_CHAT_KEY);
    if (last) navigate(`/chat/c/${last}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active conversation id so the next visit to /chat lands
  // back on it. Cleared from storage when chatId becomes undefined via
  // explicit New-chat — the redirect effect above only fires on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (chatId) window.localStorage.setItem(LAST_CHAT_KEY, chatId);
  }, [chatId]);

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
    soulNameRef,
    draftOverridesRef,
    onConversationStarted: (cid) => {
      // First send in a new conversation — server minted the id; reflect
      // it in the URL (replace, not push, so Back doesn't return to a
      // half-empty /chat). The useParams-driven render picks up the new
      // chatId and the existing message-load effect kicks in.
      if (conversationIdRef.current !== cid) {
        conversationIdRef.current = cid;
        navigate(`/chat/c/${cid}`, { replace: true });
        setListKey(k => k + 1);
        // Drafts now live on the new server-side conversation row; clear
        // local copies so subsequent meter writes go straight to the API.
        if (Object.keys(draftOverridesRef.current).length > 0) {
          setDraftOverrides({});
        }
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

  // Conv-saved model name, set when the load resolves. Held separately from
  // the active `model` state so the model-snap effect below can re-run when
  // `installed` arrives without re-triggering the load.
  const [loadedConvModel, setLoadedConvModel] = useState<string | null>(null);
  // Initial ContextMeter state, embedded in the conv hydrate response so the
  // meter can render without its own /usage round-trip. ContextMeter resets
  // its internal state to this on conv-switch.
  const [initialUsage, setInitialUsage] = useState<ChatUsageState | null>(null);
  // Increments to signal the meter to refetch /usage. Bumped only by explicit
  // user actions (model picker change). Conv-switch + post-turn use other
  // paths (initialUsage seed, chat:done WS payload) and do NOT fire HTTP.
  const [usageVersion, setUsageVersion] = useState(0);

  // Hydrate useChat's messages whenever the user picks a different
  // conversation. `setMessages` is the canonical reset path; we don't switch
  // useChat's internal `id` because that would also reset transport
  // refs / callback wiring.
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setLoadedConvModel(null);
      setInitialUsage(null);
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
        setLoadedConvModel(conv.model ?? null);
        setInitialUsage(conv.usage ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Stale URL — conversation was deleted (or the id is bogus). Clear
        // the messages list, drop the persisted last-chat id so /chat won't
        // bounce back here, and redirect to the empty-state.
        setMessages([]);
        setLoadedConvModel(null);
        setInitialUsage(null);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          try { window.localStorage.removeItem(LAST_CHAT_KEY); } catch { /* ignore */ }
          navigate('/chat', { replace: true });
        }
      });
    return () => { cancelled = true; };
  }, [conversationId, setMessages, navigate]);

  // Snap the model picker to the conversation's saved model. Runs whenever
  // the loaded conv changes OR `installed` arrives — guarded by a presence
  // check so we never set a model the user can't reach. Split out of the
  // hydrate effect so the conv + messages aren't re-fetched when `installed`
  // resolves on first paint.
  useEffect(() => {
    if (!loadedConvModel) return;
    if (installed.some(m => m.name === loadedConvModel)) {
      setModel(loadedConvModel);
    }
  }, [loadedConvModel, installed]);

  // Persist model picks to the conv row so the choice sticks across refreshes.
  // Pre-chat (no conversationId yet) only sets local state — the conv doesn't
  // exist until the first send, which folds the model into createConversation.
  // Bumps usageVersion so the meter re-fetches /usage with the new model.
  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    if (!conversationId) return;
    if (next === loadedConvModel) return;
    api.chat.renameConversation(conversationId, { model: next })
      .then(() => {
        setLoadedConvModel(next);
        setUsageVersion(v => v + 1);
      })
      .catch(() => { /* meter stays optimistic; next refresh reconciles */ });
  }, [conversationId, loadedConvModel]);

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
    setStreamError('');
    setAttachments([]);
    navigate('/chat');
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
            <aside className="w-full md:w-[280px] shrink-0 border-b md:border-b-0 md:border-r flex flex-col min-h-0">
              <ConversationList
                activeId={conversationId}
                refreshKey={listKey}
                onSelect={(id) => navigate(`/chat/c/${id}`)}
                onNew={handleNew}
              />
            </aside>
            <section className="flex flex-1 min-h-0 flex-col">
              {/* Top bar — global chat search + page tabs + context meter. Renders
                  unconditionally so the layout doesn't shift when the user
                  picks a conversation; the meter shows 0% as a placeholder
                  when there's no usage data yet. */}
              <div className="chat-topbar">
                <ChatSearch onSelect={(id) => navigate(`/chat/c/${id}`)} />
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
                  <ContextMeter
                    conversationId={conversationId}
                    model={model}
                    initialUsage={initialUsage}
                    usageVersion={usageVersion}
                    draftOverrides={draftOverrides}
                    onDraftOverrideChange={(patch) => setDraftOverrides(prev => ({ ...prev, ...patch }))}
                    soulName={soulName}
                    onSoulNameChange={setSoulName}
                  />
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
                    onModelChange={handleModelChange}
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
                    soulName={soulName}
                    onSoulNameChange={setSoulName}
                  />
                </>
              ) : (
                /* Empty-state hero: centered headline + composer + suggestion
                   pills. Mirrors ChatGPT's first-run UX. Once the user sends
                   their first message we drop into the standard thread layout
                   above. */
                <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8 overflow-y-auto">
                  <h1 className="text-2xl font-medium text-foreground">What can I help with?</h1>
                  <div className="w-full max-w-4xl">
                    <Composer
                      centered
                      installed={installed}
                      installedLoading={installedLoading || ollamaUnreachable}
                      model={model}
                      onModelChange={handleModelChange}
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
                      soulName={soulName}
                      onSoulNameChange={setSoulName}
                    />
                  </div>
                  <div className="flex max-w-4xl flex-wrap justify-center gap-2">
                    {emptyStatePrompts.map(p => (
                      <Suggestion
                        key={p}
                        suggestion={p}
                        onClick={handleSuggestion}
                        disabled={busy || !model}
                      />
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
