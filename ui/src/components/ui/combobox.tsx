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
            'flex h-9 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:border-teal-500 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-slate-400')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} autoFocus />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map(opt => (
                <CommandItem
                  key={opt.value}
                  value={`${opt.label} ${opt.value}`}
                  onSelect={() => {
                    onValueChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 text-teal-600',
                      opt.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="truncate">{opt.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
