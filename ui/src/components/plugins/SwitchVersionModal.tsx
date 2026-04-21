import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Plugin } from '../../types';
import AppModal from '../AppModal';

interface Props {
  plugin: Plugin | null;
  onClose: () => void;
  onConfirm: (plugin: Plugin, target: { id?: string; version?: string }) => Promise<void>;
}

/**
 * Version picker for an installed plugin. Lists `plugin.versions[]`
 * (populated from the catalog) plus a "Latest" shortcut when we have
 * `latest_version`. Submits `{ id, version }` to the backend, which
 * does a `git checkout`.
 */
export default function SwitchVersionModal({ plugin, onClose, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');

  if (!plugin) return null;

  const versions = plugin.versions ?? [];

  const submit = async () => {
    setError(null);
    if (!selected) {
      setError('Select a version');
      return;
    }
    const target = versions.find((v) => v.id === selected || v.version === selected);
    if (!target) {
      setError('Version not found');
      return;
    }
    setBusy(true);
    try {
      await onConfirm(plugin, { id: target.id, version: target.version });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal
      open={true}
      onClose={onClose}
      title="Switch version"
      size="sm"
      scrollBody={false}
      disableClose={busy}
      footer={
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} className="btn-primary" disabled={busy || !selected}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Switch
          </button>
        </div>
      }
    >
      <p className="text-xs text-slate-500 mb-3">
        <span className="font-medium text-slate-700">{plugin.name || plugin.id}</span> —
        currently <span className="font-mono">{plugin.version}</span>
      </p>
      <div className="space-y-1 max-h-72 overflow-y-auto pr-1 scrollbar-subtle">
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500 italic">No other versions listed in the catalog.</p>
        ) : (
          versions.map((v, i) => {
            const key = v.id || v.version || String(i);
            const isSelected = selected === (v.id || v.version);
            const isCurrent = v.version === plugin.version;
            return (
              <label
                key={key}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                  isSelected ? 'bg-teal-50' : 'hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="version"
                  className="accent-teal-600"
                  value={v.id || v.version || ''}
                  checked={isSelected}
                  onChange={() => setSelected(v.id || v.version || '')}
                  disabled={busy || isCurrent}
                />
                <span className="text-xs font-mono text-slate-700">{v.version || v.id}</span>
                {isCurrent && <span className="badge-pill badge-slate !text-[10px]">Current</span>}
                {v.deprecated && (
                  <span className="badge-pill bg-amber-50 text-amber-700 ring-amber-200 !text-[10px]">
                    Deprecated
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
      {error && (
        <p className="mt-3 text-xs text-rose-600 rounded-md bg-rose-50 border border-rose-100 px-2 py-1.5">
          {error}
        </p>
      )}
    </AppModal>
  );
}
