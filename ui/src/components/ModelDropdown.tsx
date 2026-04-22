import { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Template } from '../types';
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
  templates: Template[];
  selected: string;
  onSelect: (templateName: string) => void;
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getSubtitle(template: Template): string {
  if (template.tags.length > 0) return template.tags[0];
  return template.mediaType;
}

function getInitialColor(name: string): string {
  const colors = [
    'bg-blue-100 text-blue-700',
    'bg-teal-100 text-teal-700',
    'bg-purple-100 text-purple-700',
    'bg-orange-100 text-orange-700',
    'bg-pink-100 text-pink-700',
    'bg-green-100 text-green-700',
    'bg-indigo-100 text-indigo-700',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
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
    () => (selectedTemplate ? getInitialColor(selectedTemplate.title) : ''),
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
          className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-300 rounded-lg hover:border-gray-400 transition-colors text-left"
        >
          {selectedTemplate ? (
            <>
              <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${selectedInitialColor}`}>
                {getInitial(selectedTemplate.title)}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{selectedTemplate.title}</p>
                <p className="text-[11px] text-gray-500 truncate">{getSubtitle(selectedTemplate)}</p>
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-400 flex-1">Select a model...</span>
          )}
          <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0 max-h-72"
        align="start"
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
          <CommandList>
            <CommandEmpty>No models found</CommandEmpty>
            <CommandGroup>
              {templates.map(t => {
                const color = getInitialColor(t.title);
                const searchCorpus = `${t.title} ${t.models.join(' ')}`;
                const isSelected = t.name === selected;
                return (
                  <CommandItem
                    key={t.name}
                    value={searchCorpus}
                    onSelect={() => handleSelect(t.name)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${isSelected ? 'bg-teal-50' : ''}`}
                  >
                    <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${color}`}>
                      {getInitial(t.title)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{t.title}</p>
                      <p className="text-[11px] text-gray-500 truncate">{getSubtitle(t)}</p>
                    </div>
                    {t.models.length > 0 && (
                      <span className="text-[10px] font-medium text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded flex-shrink-0">
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
