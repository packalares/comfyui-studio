// Ollama-library grid for the Ollama panel. One card per library row, each
// with a tag picker that lazy-fetches `/chat/models/library/<name>/tags`
// and a Pull button that streams in-card progress via <PullProgress>.

import { Download, Check } from 'lucide-react';
import type { OllamaInstalledModel, OllamaLibraryModel } from '../../services/comfyui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';
import { LibraryCardTagPicker } from './LibraryCardTagPicker';
import { PullProgress } from './PullProgress';
import type { PullState } from './shared';

interface Props {
  loading: boolean;
  items: OllamaLibraryModel[];
  installed: OllamaInstalledModel[];
  pulls: Record<string, PullState>;
  debouncedLibraryQuery: string;
  librarySelectedTag: Record<string, string>;
  setLibrarySelectedTag: (next: (prev: Record<string, string>) => Record<string, string>) => void;
  handlePull: (name: string) => void;
  handleCancel: (name: string) => void;
}

export function LibraryTab({
  loading,
  items,
  installed,
  pulls,
  debouncedLibraryQuery,
  librarySelectedTag,
  setLibrarySelectedTag,
  handlePull,
  handleCancel,
}: Props) {
  // Tag-aware installed check. The user picks a variant from the per-card
  // dropdown (`selectedTag`); we count the model as installed only when
  // that exact `name:tag` pair is present locally — switching the dropdown
  // to a tag we don't have flips the badge back to "Pull".
  // Ollama's `/api/tags` typically returns names with `:latest` appended
  // even for the bare-name pull, so the `latest` branch also accepts the
  // un-suffixed form as a safety net.
  const isExactInstalled = (modelName: string, tag: string): boolean => {
    const ref = `${modelName}:${tag}`;
    return installed.some((i) =>
      i.name === ref ||
      (tag === 'latest' && (i.name === modelName || i.name === `${modelName}:latest`)),
    );
  };
  const isAnyTagInstalled = (modelName: string): boolean =>
    installed.some((i) => i.name === modelName || i.name.startsWith(`${modelName}:`));

  return (
    <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
      {loading && (
        <div className="col-span-full py-8 text-center">
          <Spinner size="lg" className="mx-auto text-muted-foreground" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
          {debouncedLibraryQuery
            ? `No models match "${debouncedLibraryQuery}".`
            : "Couldn't load the Ollama library (the upstream may be unreachable)."}
        </div>
      )}
      {items.map(m => {
        const selectedTag = librarySelectedTag[m.name] ?? 'latest';
        const pullRef = `${m.name}:${selectedTag}`;
        const pull = pulls[pullRef] ?? pulls[m.name];
        const isInstalled = isExactInstalled(m.name, selectedTag);
        const hasOtherTagInstalled = !isInstalled && isAnyTagInstalled(m.name);
        return (
          <Card key={m.name}>
            <CardHeader className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground font-mono">{m.name}</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {m.pulls} pulls · {m.tagCount} tags · {m.updated}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {m.description && <p className="text-xs text-foreground">{m.description}</p>}
              {m.sizes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.sizes.map(s => <Badge key={s} variant="neutral">{s}</Badge>)}
                </div>
              )}
              {m.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.capabilities.map(c => <Badge key={c} variant="brand">{c}</Badge>)}
                </div>
              )}
              <div>
                <label className="field-label mb-1 block">Tag / variant</label>
                <LibraryCardTagPicker
                  modelName={m.name}
                  defaultTag="latest"
                  selectedTag={selectedTag}
                  onSelect={(tag) => setLibrarySelectedTag(prev => ({ ...prev, [m.name]: tag }))}
                />
              </div>
              {pull && <PullProgress pull={pull} />}
            </CardContent>
            <CardFooter>
              <p className="text-xs text-muted-foreground">
                {isInstalled
                  ? 'Already installed'
                  : hasOtherTagInstalled
                    ? `Another tag is installed · Pulls ${pullRef}`
                    : `Pulls ${pullRef}`}
              </p>
              {isInstalled && !pull ? (
                <Badge variant="success">
                  <Check className="w-3 h-3" />
                  Installed
                </Badge>
              ) : pull ? (
                <Button onClick={() => handleCancel(pullRef)} size="sm" variant="secondary">
                  Cancel
                </Button>
              ) : (
                <Button onClick={() => handlePull(pullRef)} size="sm">
                  <Download className="w-3.5 h-3.5" />
                  Pull
                </Button>
              )}
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
