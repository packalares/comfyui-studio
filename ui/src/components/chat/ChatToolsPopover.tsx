// Tools popover for the chat composer. Lists every server-configured tool
// (web_search, rag_search, generate_image, ...) and lets the user toggle
// which subset the model is allowed to call this turn. The selection is
// owned by the parent (`Chat.tsx`) and persisted in localStorage so it
// sticks across reloads — a `null` selection means "every configured tool",
// which is the legacy behavior before this control existed.

import { useEffect, useState } from 'react';
import { Wrench, Globe, BookOpen, ImagePlus, Upload } from 'lucide-react';
import { Badge } from '../ui/badge';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { api } from '../../services/comfyui';

export interface ChatToolListing {
  name: string;
  label: string;
  description: string;
}

interface Props {
  /** null = no filter (every configured tool). string[] = explicit allow-list. */
  enabled: string[] | null;
  onChange: (next: string[] | null) => void;
}

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  web_search: Globe,
  rag_search: BookOpen,
  generate_image: ImagePlus,
  rag_upload: Upload,
};

export default function ChatToolsPopover({ enabled, onChange }: Props) {
  const [items, setItems] = useState<ChatToolListing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.chat.listTools()
      .then(({ items }) => { setItems(items); setLoaded(true); })
      .catch(() => { setItems([]); setLoaded(true); });
  }, []);

  // Hide the entire control when no tools are configured server-side — there's
  // nothing for the user to toggle and the button would just confuse.
  if (loaded && items.length === 0) return null;

  const isEnabled = (name: string) => enabled === null || enabled.includes(name);
  const enabledCount = enabled === null ? items.length : enabled.length;

  const toggle = (name: string) => {
    const current = enabled === null ? items.map(i => i.name) : [...enabled];
    if (current.includes(name)) {
      onChange(current.filter(n => n !== name));
    } else {
      onChange([...current, name]);
    }
  };

  const selectAll = () => onChange(null);
  const clearAll = () => onChange([]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Plain <button> rather than the shadcn <Button> wrapper because
          PopoverTrigger asChild forwards via Radix Slot, which needs the
          child to forward refs. <Button> is a plain function component
          without forwardRef so its ref + onClick wiring is dropped — the
          popover would never open. Other working popovers in the codebase
          (ContextMeter, ModelDropdown) use plain <button> for the same
          reason. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Tools"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 transition"
        >
          <Wrench className="h-3.5 w-3.5" />
          <span>Tools</span>
          {enabledCount > 0 && (
            <Badge variant="teal" className="ml-1">{enabledCount}</Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-slate-500">
          <span>Tools the model can call</span>
          <div className="flex items-center gap-1 normal-case">
            <button
              type="button"
              className="text-teal-700 hover:underline"
              onClick={selectAll}
            >All</button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              className="text-slate-600 hover:underline"
              onClick={clearAll}
            >None</button>
          </div>
        </div>
        <ul className="flex flex-col gap-0.5">
          {items.map((t) => {
            const Icon = ICON[t.name] ?? Wrench;
            const on = isEnabled(t.name);
            return (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => toggle(t.name)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    on ? 'bg-teal-50 hover:bg-teal-100' : 'hover:bg-slate-50'
                  }`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${on ? 'text-teal-700' : 'text-slate-500'}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium ${on ? 'text-teal-900' : 'text-slate-800'}`}>
                      {t.label}
                    </div>
                    <div className="text-[11px] leading-snug text-slate-500">
                      {t.description}
                    </div>
                  </div>
                  <span
                    aria-hidden
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${on ? 'bg-teal-500' : 'bg-slate-300'}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
