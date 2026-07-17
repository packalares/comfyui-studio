// Installed-models grid for the Ollama panel. Renders one card per row
// returned by `/chat/models`, each with a Delete affordance that hands
// the model name back up to the panel so the shared ConfirmDialog can
// gate the actual deletion.

import { Trash2 } from 'lucide-react';
import type { OllamaInstalledModel } from '../../services/comfyui';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';
import { formatBytes } from './shared';

interface Props {
  loading: boolean;
  installed: OllamaInstalledModel[];
  onRequestDelete: (name: string) => void;
}

export function InstalledTab({ loading, installed, onRequestDelete }: Props) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {loading && (
        <div className="col-span-full py-8 text-center">
          <Spinner size="lg" className="mx-auto text-muted-foreground" />
        </div>
      )}
      {!loading && installed.length === 0 && (
        <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
          No models installed. Browse the Ollama Library tab to pull one.
        </div>
      )}
      {installed.map(m => (
        <Card key={m.name}>
          <CardHeader className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground font-mono">{m.name}</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {formatBytes(m.size)}
                {m.modified_at ? ` · modified ${new Date(m.modified_at).toLocaleDateString()}` : ''}
              </p>
            </div>
            <Button
              onClick={() => onRequestDelete(m.name)}
              variant="secondary"
              className="!text-destructive hover:!bg-destructive/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </Button>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
