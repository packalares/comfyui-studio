import { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TemplateSummary } from '../types';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';

interface Props {
  templates: TemplateSummary[];
  selected: string;
  onSelect: (templateName: string) => void;
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getSubtitle(template: TemplateSummary): string {
  if (template.tags.length > 0) return template.tags[0];
  return template.mediaType;
}

// Avatar palette collapsed to neutral chrome: the model NAME differentiates
// rows; the avatar tile is just a recognizable initial. Selected row gets
// the brand accent so the active state still pops.
function getAvatarClass(isSelected: boolean): string {
  return isSelected ? 'bg-brand/10 text-brand' : 'bg-muted text-muted-foreground';
}

/**
 * Template picker used in Studio's sidebar. Visual design (avatar circle +
 * title + subtitle + first-model badge) is preserved 1:1 from the pre-cmdk
 * custom popover — the internals now delegate to shadcn Popover + Command
 * so we inherit arrow-key navigation, ARIA combobox semantics, and fuzzy
 * matching without maintaining a hand-rolled click-outside + filter loop.
 */
export default function ModelDropdown({ templates, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find(t => t.name === selected),
    [templates, selected],
  );

  const selectedInitialColor = useMemo(
    () => (selectedTemplate ? getAvatarClass(true) : ''),
    [selectedTemplate],
  );

  const handleSelect = (templateName: string) => {
    onSelect(templateName);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-card border border-input rounded-lg hover:border-input transition-colors text-left"
        >
          {selectedTemplate ? (
            <>
              <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${selectedInitialColor}`}>
                {getInitial(selectedTemplate.title)}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{selectedTemplate.title}</p>
                <p className="text-[11px] text-muted-foreground truncate">{getSubtitle(selectedTemplate)}</p>
              </div>
            </>
          ) : (
            <span className="text-sm text-muted-foreground flex-1">Select a model...</span>
          )}
          <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 rounded-md shadow-md"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        align="start"
        sideOffset={2}
      >
        <Command
          // cmdk's default filter does fuzzy substring; we also include the
          // model filenames in each item's search value so a user can type
          // a checkpoint name and find its parent template.
          filter={(value, search) => {
            const v = value.toLowerCase();
            const s = search.toLowerCase();
            return v.includes(s) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search models..." />
          {/* Visible scrollbar (overrides cmdk's `no-scrollbar`) + bottom
              padding so the last row clears the popover's rounded corner. */}
          <CommandList
            className="max-h-72 overflow-y-auto !overflow-x-hidden pb-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full"
          >
            <CommandEmpty>No models found</CommandEmpty>
            <CommandGroup>
              {templates.map(t => {
                const searchCorpus = `${t.title} ${t.models.join(' ')}`;
                const isSelected = t.name === selected;
                const color = getAvatarClass(isSelected);
                return (
                  <CommandItem
                    key={t.name}
                    value={searchCorpus}
                    onSelect={() => handleSelect(t.name)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${isSelected ? 'bg-brand/10' : ''}`}
                  >
                    <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${color}`}>
                      {getInitial(t.title)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{getSubtitle(t)}</p>
                    </div>
                    {t.models.length > 0 && (
                      <span className="ml-auto text-[10px] font-medium text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800 px-1.5 py-0.5 rounded shrink-0">
                        {t.models[0]}
                      </span>
                    )}
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
