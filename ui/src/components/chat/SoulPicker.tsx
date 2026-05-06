// SoulPicker — reusable dropdown for selecting a conversation soul (system-prompt persona).
//
// Two visual variants:
//   'pill'    — used in the Composer footer, matches the model-picker button style.
//   'compact' — used in the ContextMeter popover next to other tweakables.
//
// Fetches /api/personality/souls and /api/personality/default-soul on first
// render; results are cached in component state for the lifetime of the mount.
// When no conversation exists (pre-chat) the value is persisted in localStorage
// under 'studio.chat.soulName'. Mid-chat changes are handled by the parent.

import { useEffect, useState } from 'react';
import { ChevronDown, UserCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Check } from 'lucide-react';

interface Soul {
  name: string;
  description: string;
}

export interface SoulPickerProps {
  /** Current soul name (null = default soul). */
  value: string | null;
  /** Called when user picks a different soul. */
  onChange: (soulName: string | null) => void;
  /** Visual variant: 'pill' (composer) or 'compact' (meter popover). */
  variant?: 'pill' | 'compact';
  className?: string;
  disabled?: boolean;
}

const NULL_VALUE = '__default__';

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export default function SoulPicker({
  value,
  onChange,
  variant = 'pill',
  className,
  disabled = false,
}: SoulPickerProps) {
  const [open, setOpen] = useState(false);
  const [souls, setSouls] = useState<Soul[]>([]);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ souls: Soul[] }>('/api/personality/souls'),
      apiFetch<{ name: string | null }>('/api/personality/default-soul'),
    ])
      .then(([soulsResp, defaultResp]) => {
        if (cancelled) return;
        setSouls(soulsResp.souls);
        setDefaultName(defaultResp.name);
      })
      .catch(() => { /* non-fatal: show "Default" without a name */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const defaultLabel = defaultName ? `Default (${defaultName})` : 'Default';
  const selectedLabel = value === null
    ? defaultLabel
    : (souls.find(s => s.name === value)?.name ?? value);

  const handleSelect = (raw: string) => {
    onChange(raw === NULL_VALUE ? null : raw);
    setOpen(false);
  };

  if (variant === 'pill') {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          type="button"
          disabled={disabled || loading}
          aria-label="Pick a soul"
          className={cn(
            'btn btn-ghost btn-sm h-8 gap-1.5 px-2.5 text-xs ring-1 ring-inset ring-border hover:ring-input disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          {loading ? (
            <span
              aria-label="Loading souls"
              className="relative inline-block h-3.5 w-20 overflow-hidden rounded bg-muted"
            >
              <span className="skeleton-shimmer" />
            </span>
          ) : (
            <>
              <UserCircle2 className="h-3.5 w-3.5" />
              <span className="max-w-[120px] truncate">{selectedLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </>
          )}
        </PopoverTrigger>
        <SoulDropdown
          souls={souls}
          defaultLabel={defaultLabel}
          currentValue={value}
          onSelect={handleSelect}
        />
      </Popover>
    );
  }

  // compact variant — fits inside the meter popover section rows
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          className={cn(
            'flex h-8 w-full items-center justify-between rounded-md border border-input bg-card px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted focus:outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          aria-label="Pick a soul"
        >
          <span className="truncate">{loading ? 'Loading...' : selectedLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <SoulDropdown
        souls={souls}
        defaultLabel={defaultLabel}
        currentValue={value}
        onSelect={handleSelect}
      />
    </Popover>
  );
}

interface DropdownProps {
  souls: Soul[];
  defaultLabel: string;
  currentValue: string | null;
  onSelect: (raw: string) => void;
}

function SoulDropdown({ souls, defaultLabel, currentValue, onSelect }: DropdownProps) {
  return (
    <PopoverContent className="w-72 p-0 rounded-md shadow-md" align="start" sideOffset={4}>
      <Command>
        <CommandInput placeholder="Search souls..." autoFocus />
        <CommandList className="max-h-72 overflow-y-auto !overflow-x-hidden p-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full">
          <CommandEmpty className="py-3 text-center text-xs">No souls found.</CommandEmpty>
          <CommandGroup className="p-0">
            {/* Default item */}
            <CommandItem
              key={NULL_VALUE}
              value={defaultLabel}
              onSelect={() => onSelect(NULL_VALUE)}
              className={cn(
                'gap-2 px-2 py-1.5 text-[12px] rounded-md cursor-pointer',
                'data-[selected=true]:bg-muted',
                currentValue === null && 'bg-brand/10 text-foreground font-medium',
              )}
            >
              <Check
                className={cn(
                  'h-3.5 w-3.5 text-brand shrink-0 transition-opacity',
                  currentValue === null ? 'opacity-100' : 'opacity-0',
                )}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{defaultLabel}</span>
              </div>
            </CommandItem>
            {souls.map(soul => {
              const isSelected = currentValue === soul.name;
              return (
                <CommandItem
                  key={soul.name}
                  value={`${soul.name} ${soul.description}`}
                  onSelect={() => onSelect(soul.name)}
                  className={cn(
                    'gap-2 px-2 py-1.5 text-[12px] rounded-md cursor-pointer',
                    'data-[selected=true]:bg-muted',
                    isSelected && 'bg-brand/10 text-foreground font-medium',
                  )}
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 text-brand shrink-0 transition-opacity',
                      isSelected ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium">{soul.name}</span>
                    {soul.description && (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {soul.description}
                      </span>
                    )}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  );
}
