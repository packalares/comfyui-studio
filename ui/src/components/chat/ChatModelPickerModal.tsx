// Modal model picker built on shadcn `<Dialog>` + `<Command>`. Replaces the
// native `<select>` in `Composer.tsx` so users can search across the installed
// model list and see capability badges (vision / tools / thinking / embedding)
// inline. Capability data is sourced from the chat library scrape
// (`/api/chat/models/library`) and reused via the `libraryCapabilities` map
// the page already passes around for the vision gate.
//
// We deliberately avoid the ai-elements `<ModelSelector>` here — it ships
// provider logos via models.dev which doesn't carry Ollama models, so the
// component would render with broken `<img>` icons for every entry. The
// shadcn primitives give the same UX without external assets.

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Boxes } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '../ui/dialog';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '../ui/command';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { modelIsVisionCapable } from './attachments';
import type { OllamaInstalledModel } from '../../services/comfyui';

interface Props {
  installed: OllamaInstalledModel[];
  /** True while the first installed-models fetch is in flight. The pill
   *  trigger renders a skeleton shimmer instead of "No models installed"
   *  during this window — avoids the brief flash of a misleading label. */
  loading?: boolean;
  model: string;
  disabled?: boolean;
  libraryCapabilities?: Record<string, string[]>;
  onChange: (next: string) => void;
}

const KNOWN_CAPS = ['vision', 'tools', 'thinking', 'embedding'] as const;
type KnownCap = (typeof KNOWN_CAPS)[number];

interface DerivedRow {
  name: string;
  size?: number;
  caps: KnownCap[];
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${Math.round(mb)} MB`;
}

function capsForModel(
  name: string,
  libraryCaps?: Record<string, string[]>,
): KnownCap[] {
  const baseName = name.split(':')[0];
  const fromLib = libraryCaps?.[baseName] ?? null;
  const set = new Set<KnownCap>();
  if (fromLib) {
    for (const c of fromLib) {
      if ((KNOWN_CAPS as readonly string[]).includes(c)) {
        set.add(c as KnownCap);
      }
    }
  }
  // Heuristic fallbacks for installed-only models not in the public library.
  if (!set.has('vision') && modelIsVisionCapable(name, fromLib)) {
    set.add('vision');
  }
  if (/-thinking|qwq|deepseek-r1/i.test(name)) set.add('thinking');
  if (/embed/i.test(name)) set.add('embedding');
  return [...set];
}

function deriveRows(
  installed: OllamaInstalledModel[],
  libraryCapabilities?: Record<string, string[]>,
): DerivedRow[] {
  return installed.map((m) => ({
    name: m.name,
    size: m.size,
    caps: capsForModel(m.name, libraryCapabilities),
  }));
}

function CapBadge({ cap }: { cap: KnownCap }) {
  const label = cap;
  const variant = cap === 'vision' ? 'teal' : 'secondary';
  return <Badge variant={variant} className="text-[10px]">{label}</Badge>;
}

export default function ChatModelPickerModal({
  installed, loading, model, disabled, libraryCapabilities, onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => deriveRows(installed, libraryCapabilities),
    [installed, libraryCapabilities],
  );

  const noModel = !model;
  const noInstalled = installed.length === 0;

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || loading}
          className={cn(
            // Pill height matched to the round send button (h-8) so the
            // composer footer right-side reads as one consistent row.
            // Subtle ring at rest so it reads as a clickable affordance even
            // when the textarea is the visual focus; ring deepens on hover.
            'h-8 gap-1.5 px-2.5 text-xs ring-1 ring-inset ring-border hover:ring-input',
            // Destructive ring only once we're certain there's no model —
            // never during the initial fetch (would flash red on reload).
            !loading && noModel && 'text-destructive ring-destructive/30 bg-destructive/10',
          )}
          aria-label="Pick a chat model"
        >
          {loading ? (
            // Skeleton shimmer inside the pill while we don't yet know
            // whether a model is installed. `animate-shimmer` keyframe
            // is defined globally in `index.css`.
            <span
              aria-label="Loading models"
              className="relative inline-block h-3.5 w-28 overflow-hidden rounded bg-muted"
            >
              <span className="skeleton-shimmer" />
            </span>
          ) : (
            <>
              <Boxes className="h-3.5 w-3.5" />
              {noInstalled
                ? 'No models installed'
                : noModel
                  ? 'Pick a model'
                  : model}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Pick a chat model</DialogTitle>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search installed models..." />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>
              {noInstalled
                ? 'No Ollama models installed yet. Browse models to pull one.'
                : 'No matching models.'}
            </CommandEmpty>
            <CommandGroup heading="Installed">
              {rows.map((row) => {
                const selected = row.name === model;
                return (
                  <CommandItem
                    key={row.name}
                    value={row.name}
                    onSelect={() => handleSelect(row.name)}
                    className="flex items-start gap-2"
                  >
                    <div className="flex w-4 shrink-0 items-center pt-0.5">
                      {selected
                        ? <Check className="h-3.5 w-3.5 text-success" />
                        : null}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs">{row.name}</span>
                        {row.size !== undefined && (
                          <span className="text-[10px] text-muted-foreground">{formatSize(row.size)}</span>
                        )}
                      </div>
                      {row.caps.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {row.caps.map(c => <CapBadge key={c} cap={c} />)}
                        </div>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
