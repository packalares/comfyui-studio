import { useEffect, useState } from 'react';
import { Plus, Trash2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatConversation } from '../../services/comfyui';
import { chatEvents } from '../../services/chatEvents';

interface Props {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ConversationList({ activeId, refreshKey, onSelect, onNew }: Props) {
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.chat.listConversations()
      .then(({ items: list }) => { if (!cancelled) setItems(list); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Patch title in-place when the auto-titler broadcasts — avoids a full
  // refetch + re-sort flicker.
  useEffect(() => {
    return chatEvents.onTitle(({ conversationId, title }) => {
      setItems(prev => prev.map(c => c.id === conversationId ? { ...c, title } : c));
    });
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.chat.deleteConversation(id);
      setItems(prev => prev.filter(c => c.id !== id));
      if (activeId === id) onSelect(null);
    } catch (err) {
      toast.error('Failed to delete conversation', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="panel-header-row">
        <div className="flex items-start gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="panel-header-title leading-tight">Conversations</h2>
            <p className="panel-header-desc">
              {loading ? 'Loading...' : `${items.length} saved`}
            </p>
          </div>
        </div>
        <button onClick={onNew} className="btn-primary btn-sm" aria-label="New chat">
          <Plus className="w-3.5 h-3.5" />
          New
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-100">
        {items.length === 0 && !loading && (
          <div className="px-4 py-10 text-center text-xs text-slate-400 space-y-1">
            <MessageSquare className="mx-auto mb-1 h-5 w-5 text-slate-300" />
            <div className="font-medium text-slate-500">No conversations yet</div>
            <div>Click <span className="font-medium">New</span> above to start chatting.</div>
          </div>
        )}
        {items.map(c => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`group flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors ${
              activeId === c.id
                ? 'bg-slate-100 hover:bg-slate-100'
                : 'hover:bg-slate-50'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">
                {c.title || 'Untitled'}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                <span className="truncate font-mono">{c.model}</span>
                <span className="text-slate-300">.</span>
                <span>{formatTime(c.updated_at)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => handleDelete(c.id, e)}
              className="opacity-0 transition-opacity group-hover:opacity-100 text-slate-400 hover:text-red-600"
              aria-label="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </button>
        ))}
      </div>
    </div>
  );
}
