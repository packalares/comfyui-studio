// HuggingFace search-results grid for the Ollama panel.
//
// Each card maps a HF model id to `ollama pull hf.co/<id>` and now shows
// the SAME live-progress treatment as the Library tab (in-card spinner,
// percent, byte counter, Cancel) plus a green "Installed" badge — pulled
// from the local /chat/models list — so the user knows which models have
// already landed without leaving the panel.

import { Download, Check, Trash2 } from 'lucide-react';
import type { HfModelSummary, OllamaInstalledModel } from '../../services/comfyui';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';
import { PullProgress } from './PullProgress';
import { findInstalledMatch, type PullState } from './shared';

interface Props {
  hf: HfModelSummary[];
  hfBusy: boolean;
  hfQuery: string;
  installed: OllamaInstalledModel[];
  pulls: Record<string, PullState>;
  handlePull: (name: string) => void;
  handleCancel: (name: string) => void;
  onRequestDelete: (name: string) => void;
}

export function HuggingFaceTab({
  hf,
  hfBusy,
  hfQuery,
  installed,
  pulls,
  handlePull,
  handleCancel,
  onRequestDelete,
}: Props) {
  return (
    <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
      {hf.length === 0 && !hfBusy && (
        <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
          {hfQuery.trim() ? 'No results.' : 'Type a query to search HuggingFace.'}
        </div>
      )}
      {hfBusy && hf.length === 0 && (
        <div className="col-span-full py-8 text-center">
          <Spinner size="lg" className="mx-auto text-muted-foreground" />
        </div>
      )}
      {/* Re-search-while-results-shown: keep existing cards visible but tint
          them so the user knows a fresh result set is on the way. */}
      {hf.map(m => {
        const pullRef = `hf.co/${m.id}`;
        const pull = pulls[pullRef];
        const installedRow = findInstalledMatch(installed, pullRef);
        const isInstalled = installedRow !== null;
        return (
          <Card key={m.id} className={hfBusy ? 'opacity-60' : ''}>
            <CardHeader className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground font-mono truncate">{m.id}</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {m.downloads != null && `${m.downloads.toLocaleString()} downloads`}
                  {m.likes != null && ` · ${m.likes} likes`}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {m.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.tags.slice(0, 6).map(t => (
                    <Badge key={t} variant="neutral">{t}</Badge>
                  ))}
                </div>
              )}
              {!isInstalled && !pull && (
                <p className="text-xs text-muted-foreground">
                  Pull GGUF models into Ollama via:
                  <code className="block mt-1 rounded bg-muted px-2 py-1 font-mono">
                    ollama pull {pullRef}
                  </code>
                </p>
              )}
              {pull && <PullProgress pull={pull} />}
            </CardContent>
            <CardFooter>
              {isInstalled ? (
                <>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {installedRow.name}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="success">
                      <Check className="w-3 h-3" />
                      Installed
                    </Badge>
                    <Button
                      onClick={() => onRequestDelete(installedRow.name)}
                      size="sm"
                      variant="secondary"
                      className="!text-destructive hover:!bg-destructive/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </Button>
                  </div>
                </>
              ) : pull ? (
                <>
                  <p className="text-xs text-muted-foreground">Pulls {pullRef}</p>
                  <Button onClick={() => handleCancel(pullRef)} size="sm" variant="secondary">
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Tag is auto-selected by Ollama</p>
                  <Button onClick={() => handlePull(pullRef)} size="sm">
                    <Download className="w-3.5 h-3.5" />
                    Pull
                  </Button>
                </>
              )}
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
