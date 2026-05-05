import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatConversation } from '../../services/comfyui';
import { chatEvents } from '../../services/chatEvents';
import { Button } from '../ui/button';
import { CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';
import ConfirmDialog from '../modals/ConfirmDialog';

// How many conversations to fetch per page. Matches the server's default
// cap (20) so the first response always fills the visible viewport for
// typical screen heights without the sentinel needing to fire immediately.
const PAGE_SIZE = 20;

interface Props {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}

// Friendly relative time. Buckets: <1m → "just now"; <1h → "Nm ago";
// <today → "Nh ago"; yesterday; this week → weekday; older → "Mon DD".
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
  key: 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  items: ChatConversation[];
}

// Bucket the (already-sorted) list by `updated_at`. Today first, then
// Yesterday, then last 7 days, then everything older. Empty buckets are
// dropped so the heading isn't rendered alone.
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

export default function ConversationList({ activeId, refreshKey, onSelect, onNew }: Props) {
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Conversation pending delete-confirm (null = no dialog open). The dialog
  // is mounted once at the bottom of the tree; the row trash-can just sets
  // state to open it. Mirrors Gallery.tsx's delete-flow pattern.
  const [pendingDelete, setPendingDelete] = useState<ChatConversation | null>(null);

  // Request token used to discard out-of-order responses. Bumped on every
  // initial-load (refreshKey change); scroll-load checks it before merging.
  const reqRef = useRef(0);
  // Sentinel that triggers the next-page fetch when scrolled into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Initial load (and reload on refreshKey bump after a delete / send / etc).
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
      const res = await api.chat.listConversations({
        limit: PAGE_SIZE, offset: items.length,
      });
      if (token !== reqRef.current) return;
      setItems(prev => [...prev, ...res.items]);
      setTotal(res.total);
      setHasMore(res.hasMore);
    } catch {
      // Swallow; the sentinel stays mounted so the user can scroll-retry.
    } finally {
      if (token === reqRef.current) setLoadingMore(false);
    }
  }, [items.length, loadingMore, hasMore]);

  // IntersectionObserver — fires `loadMore` whenever the bottom sentinel
  // enters the scroll viewport. Uses a 200px rootMargin so we start
  // fetching before the user actually hits the bottom.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) void loadMore();
      },
      { rootMargin: '200px' },
    );
    io.observe(node);
    return () => { io.disconnect(); };
  }, [hasMore, loadMore]);

  // Patch title in-place when the auto-titler broadcasts — avoids a full
  // refetch + re-sort flicker.
  useEffect(() => {
    return chatEvents.onTitle(({ conversationId, title }) => {
      setItems(prev => prev.map(c => c.id === conversationId ? { ...c, title } : c));
    });
  }, []);

  const groups = useMemo(() => groupByDate(items), [items]);

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
      // Leave the dialog open so the user sees the toast — they can close
      // it manually. Re-throwing would let ConfirmDialog clear its busy
      // spinner; suppressing it keeps the spinner visible until close.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex items-center justify-between gap-3">
        <div>
          <h2 className="panel-header-title">Conversations</h2>
          <p className="panel-header-desc">
            {loading ? 'Loading…' : total === 1 ? '1 chat' : `${total} chats`}
          </p>
        </div>
        <Button onClick={onNew} size="sm" aria-label="New chat">
          <Plus className="w-3.5 h-3.5" />
          New
        </Button>
      </CardHeader>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {items.length === 0 && !loading && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground space-y-1">
            <MessageSquare className="mx-auto mb-1 h-5 w-5 text-muted-foreground" />
            <div className="font-medium text-muted-foreground">No conversations yet</div>
            <div>Click <span className="font-medium">New</span> above to start chatting.</div>
          </div>
        )}
        {groups.map(group => (
          <div key={group.key} className="mb-1">
            <div className="eyebrow px-3 pt-2 pb-1">{group.label}</div>
            {group.items.map(c => (
              <div
                key={c.id}
                className={`group chat-list-item ${activeId === c.id ? 'is-active' : ''}`}
              >
                <Link
                  to={`/chat/c/${c.id}`}
                  onClick={(e) => {
                    // Preserve onSelect for parent-side navigation hooks (it
                    // calls navigate too, which is harmless on the same path)
                    // and so right-click → "open in new tab" still works via
                    // the real `<a href>` Link emits.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    onSelect(c.id);
                  }}
                  className="min-w-0 flex-1 text-left cursor-pointer no-underline text-current"
                  aria-label={`Open ${c.title || 'Untitled'}`}
                >
                  <div className="chat-list-item-title">{c.title || 'Untitled'}</div>
                  <div className="chat-list-item-meta">{formatRelative(c.updated_at)}</div>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
                  className="hover-reveal mt-0.5 hover:text-destructive"
                  aria-label="Delete conversation"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        ))}
        {/* Sentinel — when this scrolls into view, IntersectionObserver
            fires `loadMore`. Renders only while there's more data so we
            don't re-trigger on the final page. */}
        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-3">
            {loadingMore && <Spinner size="sm" className="text-muted-foreground" />}
          </div>
        )}
      </div>
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
    </div>
  );
}
