import { useState } from 'react';
import type { Plugin } from '../../types';
import AppModal from '../modals/AppModal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

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
          <Button onClick={onClose} variant="secondary" disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !selected}>
            {busy ? <Spinner size="sm" /> : null}
            Switch
          </Button>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground mb-3">
        <span className="font-medium text-foreground">{plugin.name || plugin.id}</span> —
        currently <span className="font-mono">{plugin.version}</span>
      </p>
      <div className="space-y-1 max-h-72 overflow-y-auto pr-1 scrollbar-subtle">
        {versions.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No other versions listed in the catalog.</p>
        ) : (
          versions.map((v, i) => {
            const key = v.id || v.version || String(i);
            const isSelected = selected === (v.id || v.version);
            const isCurrent = v.version === plugin.version;
            return (
              <label
                key={key}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                  isSelected ? 'bg-brand/10' : 'hover:bg-muted'
                }`}
              >
                <input
                  type="radio"
                  name="version"
                  className="accent-brand"
                  value={v.id || v.version || ''}
                  checked={isSelected}
                  onChange={() => setSelected(v.id || v.version || '')}
                  disabled={busy || isCurrent}
                />
                <span className="text-xs font-mono text-foreground">{v.version || v.id}</span>
                {isCurrent && <Badge variant="slate" className="!text-[10px]">Current</Badge>}
                {v.deprecated && (
                  <Badge variant="amber" className="!text-[10px]">
                    Deprecated
                  </Badge>
                )}
              </label>
            );
          })
        )}
      </div>
      {error && (
        <p className="mt-3 text-xs text-destructive rounded-md bg-destructive/10 border border-destructive/30 px-2 py-1.5">
          {error}
        </p>
      )}
    </AppModal>
  );
}
