// Cmd-K style conversation search — opens as a centered <CommandDialog> with
// fuzzy keyboard nav. Server-side title match (debounced); when the query is
// empty we surface the most-recent conversations as default suggestions so
// hitting the search icon with no typing still gives the user something to
// pick. cmdk's built-in client filter is disabled (`shouldFilter={false}`) so
// it doesn't double-filter the already-narrowed server response.

import { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Spinner } from '../ui/spinner';
import { api, type ChatConversation } from '../../services/comfyui';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Click handler for a result row — page-level setConversationId. */
  onSelect: (id: string) => void;
}

function formatRelative(ts: number): string {
  if (!ts) return '';
  const delta = Date.now() - ts;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (delta < MIN) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  const d = new Date(ts);
  if (delta < 7 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ChatSearch({ open, onOpenChange, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  // Reset transient state when the dialog closes so reopening starts fresh.
  useEffect(() => {
    if (!open) { setQuery(''); setResults([]); }
  }, [open]);

  // Debounced server fetch. Empty query → recent-conversations list as
  // default suggestions; non-empty → title-match search. Each keystroke
  // increments a token so out-of-order responses can't clobber.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    const token = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(() => {
      const req = trimmed
        ? api.chat.listConversations({ q: trimmed, limit: 20 })
        : api.chat.listConversations({ limit: 12 });
      req
        .then((res) => { if (token === reqRef.current) setResults(res.items); })
        .catch(() => { if (token === reqRef.current) setResults([]); })
        .finally(() => { if (token === reqRef.current) setLoading(false); });
    }, 200);
    return () => { clearTimeout(t); };
  }, [query, open]);

  const handleSelect = (id: string) => {
    onSelect(id);
    onOpenChange(false);
  };

  const trimmed = query.trim();
  const heading = trimmed ? 'Conversations' : 'Recent conversations';

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search conversations"
      description="Type to filter your conversation history"
      className="max-w-xl"
    >
      {/* CommandDialog in this codebase doesn't auto-wrap children in
          <Command>, so we wrap explicitly and disable cmdk's built-in
          filter — the server already returned the narrowed set. */}
      <Command shouldFilter={false} className="rounded-xl">
        <CommandInput
          placeholder="Search conversations..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" className="text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <CommandEmpty>
              {trimmed
                ? `No conversations match "${trimmed}".`
                : 'No conversations yet — start one from the sidebar.'}
            </CommandEmpty>
          ) : (
            <CommandGroup heading={heading}>
              {results.map(c => (
                <CommandItem
                  key={c.id}
                  value={`${c.title || 'Untitled'} ${c.id}`}
                  onSelect={() => handleSelect(c.id)}
                >
                  <MessageSquare className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {c.title || 'Untitled'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{c.model}</span>
                      <span className="px-1">·</span>
                      <span>{formatRelative(c.updated_at)}</span>
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
