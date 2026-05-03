// Global chat-search input — server-side title match with a debounced fetch.
// Renders a Popover dropdown of matching conversations under the input;
// click a result to switch the active conversation. Title-only match for
// v1 (no message-content full-text search).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Spinner } from '../ui/spinner';
import { api, type ChatConversation } from '../../services/comfyui';

interface Props {
  /** Click handler for a result row — page-level setConversationId. */
  onSelect: (id: string) => void;
}

// Same friendly relative-time formatter as ConversationList — kept here as
// a small duplicate to avoid wiring an extra utils module just for chat.
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

export default function ChatSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const reqRef = useRef(0);

  // Debounce typing → server fetch. Each keystroke increments a request
  // token; only the latest token's response gets applied so out-of-order
  // responses don't clobber the current results.
  const trimmed = useMemo(() => query.trim(), [query]);
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }
    const token = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.chat.listConversations({ q: trimmed, limit: 10 })
        .then((res) => {
          if (token !== reqRef.current) return;
          setResults(res.items);
        })
        .catch(() => {
          if (token !== reqRef.current) return;
          setResults([]);
        })
        .finally(() => { if (token === reqRef.current) setLoading(false); });
    }, 250);
    return () => { clearTimeout(t); };
  }, [trimmed]);

  const handleSelect = (id: string) => {
    onSelect(id);
    setQuery('');
    setOpen(false);
  };

  const dropdownOpen = open && trimmed.length > 0;

  return (
    <Popover open={dropdownOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => { if (trimmed) setOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setOpen(false); } }}
            className="field-input pl-8 pr-7 h-7 text-xs"
            aria-label="Search conversations"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setOpen(false); }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        // Stop Radix from yanking focus back to the input on open — the
        // user is still typing, we don't want the popover to steal focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-80 p-1"
      >
        {loading && results.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <Spinner size="sm" className="text-slate-400" />
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-3 text-xs text-slate-500 text-center">
            No conversations match "{trimmed}".
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {results.map(c => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(c.id)}
                  className="w-full text-left chat-list-item cursor-pointer"
                >
                  <div className="min-w-0 flex-1">
                    <div className="chat-list-item-title">{c.title || 'Untitled'}</div>
                    <div className="chat-list-item-meta">
                      <span className="font-mono">{c.model}</span>
                      <span className="text-slate-300 px-1">·</span>
                      <span>{formatRelative(c.updated_at)}</span>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
