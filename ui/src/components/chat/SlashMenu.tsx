// Slash-command popover for the chat composer.
// Opens when the textarea value matches /^\/(\w*)$/ (slash at start, nothing else).
// Uses the shadcn Command primitive for fuzzy search + keyboard navigation.
// Fetches /api/commands once on mount and caches for the lifetime of this component.

import { useEffect, useState, useRef } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { CommandSummary } from '../../services/comfyui';
import { api } from '../../services/comfyui';

interface Props {
  open: boolean;
  /** The partial text after the slash (used to pre-filter the cmdk input). */
  query: string;
  onSelect: (name: string) => void;
  onClose: () => void;
  /** The trigger element — the composer textarea wrapper. */
  children: React.ReactNode;
}

export default function SlashMenu({ open, query, onSelect, onClose, children }: Props) {
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const fetched = useRef(false);

  // Fetch once per mount; subsequent opens reuse the cached list.
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    api.commands.list()
      .then(r => setCommands(r.commands))
      .catch(() => { /* non-fatal; menu shows empty state */ });
  }, []);

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        side="top"
        sideOffset={6}
        // Prevent the popover from stealing focus from the textarea.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command>
          <CommandInput
            placeholder="Search commands..."
            value={query}
            // Read-only: query is driven by the textarea value, not typed here.
            onValueChange={() => { /* controlled externally */ }}
          />
          <CommandList className="max-h-64">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No commands. Create one in Settings &rarr; Commands.
            </CommandEmpty>
            <CommandGroup className="p-0">
              {commands.map(cmd => (
                <CommandItem
                  key={cmd.name}
                  value={`${cmd.name} ${cmd.description}`}
                  onSelect={() => onSelect(cmd.name)}
                  className="gap-2 px-3 py-2 text-xs cursor-pointer"
                >
                  <span className="font-mono font-semibold text-foreground shrink-0">
                    /{cmd.name}
                  </span>
                  <span className="truncate text-muted-foreground flex-1">
                    {cmd.description}
                  </span>
                  {cmd.argument_hint && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60 italic">
                      {cmd.argument_hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
