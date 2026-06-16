import { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TemplateSummary } from '../types';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// Per-template avatar: tries to load the saved thumbnail from
// `/api/thumbnail/template/<name>-1.webp` and falls back to the initial-
// letter circle when the image errors (no thumbnail saved on disk yet).
// Local state per instance so a failed load on one row doesn't suppress
// another row's image.
function TemplateAvatar({
  template, isSelected, size = 7,
}: { template: TemplateSummary; isSelected: boolean; size?: 7 | 8 }) {
  const [imgFailed, setImgFailed] = useState(false);
  const palette = isSelected ? 'bg-brand/10 text-brand' : 'bg-muted text-muted-foreground';
  const dim = size === 7 ? 'w-7 h-7' : 'w-8 h-8';
  // 64 px wide is enough for the dropdown row at 1× and 2× DPI; the cache
  // service downscales from the on-disk asset.
  const src = `/api/thumbnail/template/${encodeURIComponent(template.name)}-1.webp?w=64`;
  if (imgFailed) {
    return (
      <span className={`flex-shrink-0 ${dim} rounded-full flex items-center justify-center text-xs font-bold ${palette}`}>
        {template.title.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={`flex-shrink-0 ${dim} rounded-full object-cover bg-muted`}
      onError={() => setImgFailed(true)}
    />
  );
}
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

function getSubtitle(template: TemplateSummary): string {
  if (template.tags && template.tags.length > 0) return template.tags[0];
  return template.mediaType;
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
              <TemplateAvatar template={selectedTemplate} isSelected />
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
                const models = t.models ?? [];
                const searchCorpus = `${t.title} ${models.join(' ')}`;
                const isSelected = t.name === selected;
                // Model filename badge removed — it crowded the row and
                // made the template title hard to read. The model name is
                // still part of `searchCorpus`, so users can still filter
                // by checkpoint filename in the search box.
                return (
                  <CommandItem
                    key={t.name}
                    value={searchCorpus}
                    onSelect={() => handleSelect(t.name)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${isSelected ? 'bg-brand/10' : ''}`}
                  >
                    <TemplateAvatar template={t} isSelected={isSelected} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{getSubtitle(t)}</p>
                    </div>
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
