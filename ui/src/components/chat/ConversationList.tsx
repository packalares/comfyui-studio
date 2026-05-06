import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, MessageSquare, MoreHorizontal, Pin, PinOff, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatConversation } from '../../services/comfyui';
import { chatEvents } from '../../services/chatEvents';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';
import ConfirmDialog from '../modals/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';

const PAGE_SIZE = 20;

interface Props {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}

function formatRelative(ts: number): string {
  if (!ts) return '';
  const now = Date.now();
  const delta = now - ts;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (delta < MIN) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
  if (delta < 7 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface Group {
  key: string;
  label: string;
  items: ChatConversation[];
}

function groupByDate(items: ChatConversation[]): Group[] {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekAgoStart = todayStart - 7 * 24 * 60 * 60 * 1000;
  const groups: Group[] = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'week', label: 'Previous 7 days', items: [] },
    { key: 'older', label: 'Older', items: [] },
  ];
  for (const c of items) {
    const ts = c.updated_at;
    if (ts >= todayStart) groups[0].items.push(c);
    else if (ts >= yesterdayStart) groups[1].items.push(c);
    else if (ts >= weekAgoStart) groups[2].items.push(c);
    else groups[3].items.push(c);
  }
  return groups.filter(g => g.items.length > 0);
}

// ---- Inline rename sub-component ----------------------------------------
interface RenameInputProps {
  initialValue: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}
function RenameInput({ initialValue, onSave, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialValue) onSave(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={commit}
      className="min-w-0 flex-1 rounded border border-brand bg-background px-1.5 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-brand"
      aria-label="Rename conversation"
    />
  );
}

// ---- Main component -------------------------------------------------------
export default function ConversationList({ activeId, refreshKey, onSelect, onNew }: Props) {
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  /** id of the conversation currently being renamed inline */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const reqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const token = ++reqRef.current;
    setLoading(true);
    api.chat.listConversations({ limit: PAGE_SIZE, offset: 0 })
      .then((res) => {
        if (token !== reqRef.current) return;
        setItems(res.items);
        setTotal(res.total);
        setHasMore(res.hasMore);
      })
      .catch(() => {
        if (token !== reqRef.current) return;
        setItems([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => { if (token === reqRef.current) setLoading(false); });
  }, [refreshKey]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const token = reqRef.current;
    setLoadingMore(true);
    try {
      const res = await api.chat.listConversations({ limit: PAGE_SIZE, offset: items.length });
      if (token !== reqRef.current) return;
      setItems(prev => [...prev, ...res.items]);
      setTotal(res.total);
      setHasMore(res.hasMore);
    } catch {
      // silent; sentinel stays mounted for scroll-retry
    } finally {
      if (token === reqRef.current) setLoadingMore(false);
    }
  }, [items.length, loadingMore, hasMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) if (e.isIntersecting) void loadMore(); },
      { rootMargin: '200px' },
    );
    io.observe(node);
    return () => { io.disconnect(); };
  }, [hasMore, loadMore]);

  useEffect(() => {
    return chatEvents.onTitle(({ conversationId, title }) => {
      setItems(prev => prev.map(c => c.id === conversationId ? { ...c, title } : c));
    });
  }, []);

  // Separate pinned from unpinned, then bucket unpinned by date
  const pinned = useMemo(() => items.filter(c => c.pinned), [items]);
  const unpinned = useMemo(() => items.filter(c => !c.pinned), [items]);
  const groups = useMemo(() => groupByDate(unpinned), [unpinned]);

  // ---- Actions ----

  const handleDeleteConfirmed = async (): Promise<void> => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    try {
      await api.chat.deleteConversation(id);
      setItems(prev => prev.filter(c => c.id !== id));
      setTotal(t => Math.max(0, t - 1));
      if (activeId === id) onSelect(null);
      setPendingDelete(null);
    } catch (err) {
      toast.error('Failed to delete conversation', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDeleteAllConfirmed = async (): Promise<void> => {
    try {
      await api.chat.deleteAllConversations();
      setItems([]);
      setTotal(0);
      setHasMore(false);
      onSelect(null);
      setDeleteAllOpen(false);
    } catch (err) {
      toast.error('Failed to delete all conversations', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleTogglePin = async (c: ChatConversation): Promise<void> => {
    const next = !c.pinned;
    // Optimistic update
    setItems(prev => prev.map(x => x.id === c.id ? { ...x, pinned: next } : x));
    try {
      await api.chat.renameConversation(c.id, { pinned: next });
    } catch (err) {
      // Revert
      setItems(prev => prev.map(x => x.id === c.id ? { ...x, pinned: c.pinned } : x));
      toast.error('Failed to update pin', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRename = async (c: ChatConversation, title: string): Promise<void> => {
    setRenamingId(null);
    setItems(prev => prev.map(x => x.id === c.id ? { ...x, title } : x));
    try {
      await api.chat.renameConversation(c.id, { title });
    } catch (err) {
      setItems(prev => prev.map(x => x.id === c.id ? { ...x, title: c.title } : x));
      toast.error('Rename failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ---- Row renderer ----

  const renderRow = (c: ChatConversation) => {
    const isActive = activeId === c.id;
    const isRenaming = renamingId === c.id;

    return (
      <div
        key={c.id}
        className={`group chat-list-item ${isActive ? 'is-active' : ''}`}
      >
        {isRenaming ? (
          <RenameInput
            initialValue={c.title || 'Untitled'}
            onSave={(title) => void handleRename(c, title)}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <Link
            to={`/chat/c/${c.id}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              onSelect(c.id);
            }}
            className="min-w-0 flex-1 text-left cursor-pointer no-underline text-current"
            aria-label={`Open ${c.title || 'Untitled'}`}
          >
            <div className="chat-list-item-title">{c.title || 'Untitled'}</div>
            <div className="chat-list-item-meta flex items-center gap-1.5">
              {c.model && (
                <span className="max-w-[90px] truncate rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                  {c.model}
                </span>
              )}
              <span>{formatRelative(c.updated_at)}</span>
            </div>
          </Link>
        )}

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="More options"
            className="btn btn-secondary mt-0.5"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </DropdownMenuTrigger>
          
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); void handleTogglePin(c); }}
            >
              {c.pinned
                ? <><PinOff className="w-3.5 h-3.5" />Unpin</>
                : <><Pin className="w-3.5 h-3.5" />Pin</>
              }
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); setRenamingId(c.id); }}
            >
              <Pencil className="w-3.5 h-3.5" />Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
            >
              <Trash2 className="w-3.5 h-3.5" />Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  // ---- Render ----

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex items-center justify-between gap-3">
        <h2 className="panel-header-title">Conversations</h2>
        <ButtonGroup>
          <Button onClick={onNew}  aria-label="New chat">
            <Plus className="w-3.5 h-3.5" />
            New
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              aria-label="More options"
              className="btn btn-secondary"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem
                variant="destructive"
                disabled={items.length === 0}
                onClick={() => setDeleteAllOpen(true)}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete all ({total})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </CardHeader>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {items.length === 0 && !loading && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground space-y-1">
            <MessageSquare className="mx-auto mb-1 h-5 w-5 text-muted-foreground" />
            <div className="font-medium text-muted-foreground">No conversations yet</div>
            <div>Click <span className="font-medium">New</span> above to start chatting.</div>
          </div>
        )}

        {/* Pinned group */}
        {pinned.length > 0 && (
          <div className="mb-1">
            <div className="eyebrow px-3 pt-2 pb-1">Pinned</div>
            {pinned.map(renderRow)}
          </div>
        )}

        {/* Date groups (unpinned) */}
        {groups.map(group => (
          <div key={group.key} className="mb-1">
            <div className="eyebrow px-3 pt-2 pb-1">{group.label}</div>
            {group.items.map(renderRow)}
          </div>
        ))}

        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-3">
            {loadingMore && <Spinner size="sm" className="text-muted-foreground" />}
          </div>
        )}
      </div>

      {/* Per-row delete dialog */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete conversation?"
        description={
          pendingDelete
            ? `"${pendingDelete.title || 'Untitled'}" will be permanently removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={handleDeleteConfirmed}
      />

      {/* Delete all dialog */}
      <ConfirmDialog
        open={deleteAllOpen}
        onClose={() => setDeleteAllOpen(false)}
        title="Delete all conversations?"
        description={`Delete all ${total} conversation${total === 1 ? '' : 's'}? This cannot be undone.`}
        confirmLabel="Delete all"
        confirmTone="danger"
        onConfirm={handleDeleteAllConfirmed}
      />
    </div>
  );
}
