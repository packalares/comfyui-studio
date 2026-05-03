import { useEffect, useState } from 'react';
import { api } from '../../services/comfyui';
import { Button } from '../ui/button';
import { Card, CardFooter, CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';

interface Props {
  open: boolean;
  modelName: string;
  preferred?: string;
  onCancel: () => void;
  onConfirm: (folder: string) => void;
}

// Catalog rows with no `save_path` and no recognised `type` need an explicit
// destination; this dialog fetches ComfyUI's registered model folders and
// blocks the install until the user picks one. Avoids the prior silent
// fallback to `checkpoints/` for ONNX / GGUF / detector files.
export default function ModelFolderPickerModal({
  open, modelName, preferred, onCancel, onConfirm,
}: Props): JSX.Element | null {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFolders(null);
    let cancelled = false;
    api.getRegisteredFolders()
      .then((list) => {
        if (cancelled) return;
        setFolders(list);
        const initial = preferred && list.includes(preferred) ? preferred : (list[0] ?? '');
        setSelected(initial);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load folders');
      });
    return () => { cancelled = true; };
  }, [open, preferred]);

  if (!open) return null;

  const ready = folders !== null && folders.length > 0 && selected !== '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}>
      <Card className="w-full max-w-md flex flex-col">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Choose download folder</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">No folder hint for this model — pick a destination.</p>
        </CardHeader>
        <div className="p-4 space-y-3">
          <div>
            <label className="field-label mb-1.5 block">Model</label>
            <div className="text-xs font-mono text-slate-700 break-all">{modelName}</div>
          </div>
          <div>
            <label htmlFor="model-folder-select" className="field-label mb-1.5 block">Destination folder</label>
            {folders === null && !error && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Spinner size="sm" />
                Loading folders…
              </div>
            )}
            {error && (
              <div className="text-xs text-red-600">{error}</div>
            )}
            {folders !== null && folders.length === 0 && (
              <div className="text-xs text-amber-700">
                ComfyUI returned no folders. Start ComfyUI and try again.
              </div>
            )}
            {folders !== null && folders.length > 0 && (
              <select
                id="model-folder-select"
                className="field-input border border-slate-300 rounded px-2 py-1.5 w-full"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {folders.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <CardFooter className="justify-end">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            disabled={!ready}
            onClick={() => ready && onConfirm(selected)}
          >
            Download
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
