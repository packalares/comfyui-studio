import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../services/comfyui';

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
    <div className="modal-overlay bg-slate-900/40 backdrop-blur-sm" onClick={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}>
      <div className="w-full max-w-md panel flex flex-col">
        <div className="panel-header">
          <h2 className="panel-header-title">Choose download folder</h2>
          <p className="panel-header-desc">No folder hint for this model — pick a destination.</p>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="field-label mb-1.5 block">Model</label>
            <div className="text-xs font-mono text-slate-700 break-all">{modelName}</div>
          </div>
          <div>
            <label htmlFor="model-folder-select" className="field-label mb-1.5 block">Destination folder</label>
            {folders === null && !error && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
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
        <div className="panel-footer flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!ready}
            onClick={() => ready && onConfirm(selected)}
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
