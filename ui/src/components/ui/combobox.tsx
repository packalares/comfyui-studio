import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

/** Threshold above which select fields swap to the searchable Combobox.
 *  Short lists stay on the vanilla Select to preserve muscle memory. */
export const COMBOBOX_SEARCH_THRESHOLD = 10;

export interface ComboboxOption {
  label: string;
  value: string;
}

export interface ComboboxProps {
  value: string;
  onValueChange: (v: string) => void;
  options: Array<ComboboxOption>;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No results found.',
  disabled,
  className,
}: ComboboxProps): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const selected = options.find(o => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input bg-card px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted focus:outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 rounded-md shadow-md"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        sideOffset={2}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} autoFocus />
          {/* Visible thin scrollbar (overrides cmdk's `no-scrollbar` default).
              Bottom padding ensures the last item clears the rounded corner. */}
          <CommandList
            className="max-h-72 overflow-y-auto !overflow-x-hidden p-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full"
          >
            <CommandEmpty className="py-3 text-center text-xs">{emptyMessage}</CommandEmpty>
            <CommandGroup className="p-0">
              {options.map(opt => {
                const isSelected = opt.value === value;
                return (
                  <CommandItem
                    key={opt.value}
                    value={`${opt.label} ${opt.value}`}
                    onSelect={() => {
                      onValueChange(opt.value);
                      setOpen(false);
                    }}
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
                    <span className="truncate flex-1">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
