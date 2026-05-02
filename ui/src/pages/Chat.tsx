import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useChat } from '@ai-sdk/react';
import PageSubbar from '../components/PageSubbar';
import ConversationList from '../components/chat/ConversationList';
import MessageThread from '../components/chat/MessageThread';
import Composer from '../components/chat/Composer';
import ContextMeter from '../components/chat/ContextMeter';
import { Button } from '../components/ui/button';
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

export default function Chat() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [model, setModel] = useState<string>('');
  const [streamError, setStreamError] = useState<string>('');
  const [listKey, setListKey] = useState(0);
  // 502 from /api/chat/models means Ollama itself is unreachable - surface a
  // banner so the user can fix Settings without opening the browser console.
  const [ollamaUnreachable, setOllamaUnreachable] = useState(false);
  // Pending attachments staged in the composer + appended via drag-drop on
  // the thread. Owned here so both children read the same source of truth.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Capabilities map (basename -> ['vision', ...]) sourced from the chat
  // library endpoint. Used by the composer for an authoritative vision
  // check before falling back to the name-pattern heuristic.
  const [libraryCaps, setLibraryCaps] = useState<Record<string, string[]>>({});
  const composerFocusRef = useRef<() => void>(() => {});

  // Refs used by `StudioTransport` so the transport always reads the latest
  // conversationId / model without forcing a recreate on every change. The
  // page-state setters update the refs synchronously below.
  const conversationIdRef = useRef<string | null>(null);
  const modelRef = useRef<string>('');
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => { modelRef.current = model; }, [model]);

  // useChat owns: messages, status, stop, regenerate, setMessages.
  // Transport bridges to Studio's POST /chat/start + chatEvents bus.
  const transport = useMemo(() => new StudioTransport({
    conversationIdRef,
    modelRef,
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
    messages, sendMessage, status, stop, setMessages,
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
    api.getChatSettings()
      .then(s => { if (s.defaultModel) setModel(s.defaultModel); })
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
      });
  }, []);

  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  // Hydrate useChat's messages whenever the user picks a different
  // conversation. `setMessages` is the canonical reset path; we don't switch
  // useChat's internal `id` because that would also reset transport
  // refs / callback wiring.
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api.chat.getMessages(conversationId)
      .then(({ items }) => {
        if (cancelled) return;
        setMessages(items.map(chatMessageToUIMessage));
      })
      .catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
  }, [conversationId, setMessages]);

  // Auto-title broadcast updates the sidebar without a refetch.
  useEffect(() => {
    return chatEvents.onTitle(() => { setListKey(k => k + 1); });
  }, []);

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
        right={
          <Button asChild variant="secondary" size="sm" aria-label="Browse models">
            <Link to="/chat/models">
              <Boxes className="w-3.5 h-3.5" />
              Browse models
            </Link>
          </Button>
        }
      />
      <div className="page-container">
        {ollamaUnreachable && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Ollama is not reachable.</div>
              <div className="text-xs text-rose-700">
                Check the URL in <Link to="/settings" className="underline">Settings</Link> and make sure Ollama is running.
              </div>
            </div>
            <Button onClick={refreshInstalled} variant="secondary" size="sm">Retry</Button>
          </div>
        )}
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
              {hasConversation && conversationId && (
                <div className="flex items-center justify-end gap-2 border-b border-slate-100 px-3 py-1.5">
                  <ContextMeter conversationId={conversationId} model={model} />
                </div>
              )}
              <MessageThread
                messages={messages}
                status={status}
                streamError={streamError}
                hasConversation={hasConversation}
                onFilesDropped={handleFilesDropped}
              />
              <Composer
                installed={installed}
                model={model}
                onModelChange={setModel}
                busy={busy}
                onSend={handleSend}
                onStop={handleStop}
                focusRef={composerFocusRef}
                libraryCapabilities={libraryCaps}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
              />
            </section>
          </div>
        </Card>
      </div>
    </>
  );
}
