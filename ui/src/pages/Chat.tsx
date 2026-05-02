import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import PageSubbar from '../components/PageSubbar';
import ConversationList from '../components/chat/ConversationList';
import MessageThread from '../components/chat/MessageThread';
import Composer from '../components/chat/Composer';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import {
  api, ApiError, type ChatMessage, type OllamaInstalledModel,
} from '../services/comfyui';
import { chatEvents, type ChatToolPart } from '../services/chatEvents';
import {
  buildUserMessageParts, MAX_ATTACHMENTS, processFile,
  type PendingAttachment,
} from '../components/chat/attachments';

function makeLocalId(): string {
  return 'local_' + Math.random().toString(36).slice(2, 12);
}

export default function Chat() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [model, setModel] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState<string>('');
  const [streamError, setStreamError] = useState<string>('');
  const [streamingTools, setStreamingTools] = useState<ChatToolPart[]>([]);
  const [listKey, setListKey] = useState(0);
  // 502 from /api/chat/models means Ollama itself is unreachable — surface a
  // banner so the user can fix Settings without opening the browser console.
  const [ollamaUnreachable, setOllamaUnreachable] = useState(false);
  // Pending attachments staged in the composer + appended via drag-drop on
  // the thread. Owned here so both children read the same source of truth.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Capabilities map (basename -> ['vision', ...]) sourced from the chat
  // library endpoint. Used by the composer for an authoritative vision
  // check before falling back to the name-pattern heuristic.
  const [libraryCaps, setLibraryCaps] = useState<Record<string, string[]>>({});
  const streamingTextRef = useRef('');
  const composerFocusRef = useRef<() => void>(() => {});

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

  useEffect(() => {
    if (!conversationId) { setMessages([]); return; }
    let cancelled = false;
    api.chat.getMessages(conversationId)
      .then(({ items }) => { if (!cancelled) setMessages(items); })
      .catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => {
    const offChunk = chatEvents.onChunk(({ msgId, delta }) => {
      if (msgId !== streamingMsgId) return;
      // First chunk lands - drop the "loading" hint.
      if (streamingTextRef.current.length === 0) setStreamStatus('');
      streamingTextRef.current += delta;
      setStreamingText(streamingTextRef.current);
    });
    const offStatus = chatEvents.onStatus(({ msgId, message }) => {
      if (msgId !== streamingMsgId) return;
      setStreamStatus(message);
    });
    const offTool = chatEvents.onTool(({ msgId, part }) => {
      if (msgId !== streamingMsgId) return;
      setStreamingTools(prev => [...prev, part]);
    });
    const offDone = chatEvents.onDone(({ msgId }) => {
      if (msgId !== streamingMsgId) return;
      setBusy(false);
      const finalText = streamingTextRef.current;
      streamingTextRef.current = '';
      setStreamingText('');
      setStreamingMsgId(null);
      setStreamStatus('');
      setStreamingTools([]);
      if (conversationId) {
        api.chat.getMessages(conversationId)
          .then(({ items }) => setMessages(items))
          .catch(() => {
            setMessages(prev => prev.map(m => m.id === msgId
              ? { ...m, parts: [{ type: 'text', text: finalText }] }
              : m));
          });
        setListKey(k => k + 1);
      }
    });
    const offError = chatEvents.onError(({ msgId, error }) => {
      if (msgId !== streamingMsgId) return;
      toast.error('Chat stream failed', { description: error });
      setStreamError(error);
      setBusy(false);
      streamingTextRef.current = '';
      setStreamingText('');
      setStreamingMsgId(null);
      setStreamStatus('');
      setStreamingTools([]);
    });
    return () => { offChunk(); offStatus(); offTool(); offDone(); offError(); };
  }, [streamingMsgId, conversationId]);

  // Auto-title broadcast updates the sidebar without a refetch.
  useEffect(() => {
    return chatEvents.onTitle(() => { setListKey(k => k + 1); });
  }, []);

  const handleSend = async (text: string, atts: PendingAttachment[]) => {
    if (busy) return;
    if (!model) {
      toast.error('No model selected');
      return;
    }
    setStreamError('');
    setStreamingTools([]);
    const parts = buildUserMessageParts(text, atts);
    if (parts.length === 0) return;
    const localUserMsg: ChatMessage = {
      id: makeLocalId(),
      conversationId: conversationId ?? 'pending',
      role: 'user',
      parts,
      tokens_in: null, tokens_out: null,
      ms_to_first_token: null, ms_total: null,
      tokens_per_sec: null,
      model: null,
      created_at: Date.now(),
    };
    const wireMessages = [...messages, localUserMsg].map(m => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
    }));
    setMessages(prev => [...prev, localUserMsg]);
    setBusy(true);
    streamingTextRef.current = '';
    setStreamingText('');
    setStreamStatus('');
    try {
      const { conversationId: cid, msgId } = await api.chat.start({
        conversationId: conversationId ?? undefined,
        model,
        messages: wireMessages,
      });
      setConversationId(cid);
      setStreamingMsgId(msgId);
      setMessages(prev => [...prev, {
        id: msgId,
        conversationId: cid,
        role: 'assistant',
        parts: [{ type: 'text', text: '' }],
        tokens_in: null, tokens_out: null,
        ms_to_first_token: null, ms_total: null,
        tokens_per_sec: null,
        model,
        created_at: Date.now(),
      }]);
      setListKey(k => k + 1);
    } catch (err) {
      toast.error('Failed to start chat', {
        description: err instanceof Error ? err.message : String(err),
      });
      setBusy(false);
      setMessages(prev => prev.filter(m => m.id !== localUserMsg.id));
    }
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
    if (!streamingMsgId) return;
    try { await api.chat.stop(streamingMsgId); } catch { /* ignore */ }
  }, [streamingMsgId]);

  const handleNew = () => {
    setConversationId(null);
    setMessages([]);
    streamingTextRef.current = '';
    setStreamingText('');
    setStreamingMsgId(null);
    setBusy(false);
    setStreamStatus('');
    setStreamError('');
    setStreamingTools([]);
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
      if (e.key === 'Escape' && streamingMsgId) {
        e.preventDefault();
        void handleStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [streamingMsgId, handleStop]);

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
              <MessageThread
                messages={messages}
                streamingMsgId={streamingMsgId}
                streamingText={streamingText}
                streamStatus={streamStatus}
                streamError={streamError}
                busy={busy}
                hasConversation={conversationId !== null || messages.length > 0}
                streamingTools={streamingTools}
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
