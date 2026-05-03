import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Plus,
  RefreshCw,
  AlertTriangle,
  Trash2,
  Package as PackageIcon,
} from 'lucide-react';
import { api } from '../../services/comfyui';
import { usePersistedState } from '../../hooks/usePersistedState';
import type { PythonPackage } from '../../types';
import { Spinner } from '../ui/spinner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';

interface OpState {
  busy: boolean;
  error?: string;
  output?: string;
  success?: boolean;
}

/**
 * pip package browser: install by spec, search, uninstall.
 * Operates on the ComfyUI python environment via the /python routes.
 */
export default function PackagesPanel() {
  const [packages, setPackages] = useState<PythonPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = usePersistedState('python.packages.search', '');
  const [installSpec, setInstallSpec] = useState('');
  const [installOp, setInstallOp] = useState<OpState>({ busy: false });
  const [uninstallOps, setUninstallOps] = useState<Record<string, OpState>>({});
  const [deleteTarget, setDeleteTarget] = useState<PythonPackage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listPythonPackages();
      setPackages(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list packages');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleInstall = useCallback(async () => {
    const spec = installSpec.trim();
    if (!spec) return;
    setInstallOp({ busy: true });
    try {
      const r = await api.installPythonPackage(spec);
      setInstallOp({ busy: false, success: true, output: r.output });
      setInstallSpec('');
      await load();
    } catch (err) {
      setInstallOp({
        busy: false,
        success: false,
        error: err instanceof Error ? err.message : 'Install failed',
      });
    }
  }, [installSpec, load]);

  const handleUninstall = useCallback(async () => {
    if (!deleteTarget) return;
    const pkg = deleteTarget;
    setDeleteTarget(null);
    setUninstallOps((prev) => ({ ...prev, [pkg.name]: { busy: true } }));
    try {
      const r = await api.uninstallPythonPackage(pkg.name);
      setUninstallOps((prev) => ({
        ...prev,
        [pkg.name]: { busy: false, success: true, output: r.output },
      }));
      await load();
    } catch (err) {
      setUninstallOps((prev) => ({
        ...prev,
        [pkg.name]: {
          busy: false,
          success: false,
          error: err instanceof Error ? err.message : 'Uninstall failed',
        },
      }));
    }
  }, [deleteTarget, load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return packages;
    const q = search.toLowerCase();
    return packages.filter(
      (p) => p.name.toLowerCase().includes(q) || p.version.toLowerCase().includes(q),
    );
  }, [packages, search]);

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <PackageIcon className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 leading-tight">Installed packages</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{packages.length} installed via pip.</p>
          </div>
        </div>
        <Button
          onClick={load}
          variant="ghost"
          size="icon"
          title="Refresh"
          disabled={loading}
          aria-label="Refresh package list"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Install input */}
        <div className="flex flex-col md:flex-row gap-2">
          <div className="flex-1 field-wrap">
            <PackageIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              className="field-input"
              placeholder="Package spec, e.g. numpy==1.26.4"
              value={installSpec}
              onChange={(e) => setInstallSpec(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleInstall();
              }}
              disabled={installOp.busy}
            />
          </div>
          <Button
            onClick={handleInstall}
            disabled={installOp.busy || !installSpec.trim()}
          >
            {installOp.busy ? <Spinner size="sm" /> : <Plus className="w-3.5 h-3.5" />}
            Install
          </Button>
        </div>

        {installOp.error && (
          <p className="text-[11px] text-rose-600 rounded-md bg-rose-50 border border-rose-100 px-2 py-1.5 break-all">
            {installOp.error}
          </p>
        )}
        {installOp.success && (
          <p className="text-[11px] text-emerald-700 rounded-md bg-emerald-50 border border-emerald-100 px-2 py-1.5">
            Install succeeded.
          </p>
        )}

        {/* Search */}
        <div className="field-wrap">
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input
            type="text"
            className="field-input"
            placeholder="Search installed packages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 flex items-center gap-2 text-xs text-rose-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner size="lg" className="text-slate-400" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-box">
            {packages.length === 0 ? 'No packages reported by pip.' : 'No packages match your search.'}
          </div>
        ) : (
          <div className="max-h-[480px] overflow-y-auto scrollbar-subtle">
            <ul className="divide-y divide-slate-100">
              {filtered.map((p) => {
                const op = uninstallOps[p.name];
                return (
                  <li
                    key={p.name}
                    className="flex items-center gap-3 px-1 py-1.5 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-3">
                      <span className="font-mono text-sm text-slate-900 truncate">{p.name}</span>
                      <span className="font-mono text-xs text-slate-500 shrink-0">{p.version}</span>
                    </div>
                    {op?.error && (
                      <span className="text-[11px] text-rose-600 font-mono truncate" title={op.error}>
                        {op.error}
                      </span>
                    )}
                    <Button
                      onClick={() => setDeleteTarget(p)}
                      disabled={op?.busy}
                      variant="ghost"
                      size="icon"
                      className="hover:!text-red-500"
                      aria-label={`Uninstall ${p.name}`}
                      title="Uninstall"
                    >
                      {op?.busy ? (
                        <Spinner size="md" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall package?</AlertDialogTitle>
            <AlertDialogDescription>
              Runs <code className="font-mono">pip uninstall -y {deleteTarget?.name}</code> on the
              ComfyUI Python environment. Plugins that depend on it may break.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUninstall} className="!bg-red-600 hover:!bg-red-700">
              <Trash2 className="w-3.5 h-3.5" />
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
