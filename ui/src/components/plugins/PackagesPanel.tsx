import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
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
import type { PluginsOutletContext } from '../../pages/Plugins';
import { Spinner } from '../ui/spinner';
import ConfirmDialog from '../modals/ConfirmDialog';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

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

  // Refresh + "install by spec" input live in the shared Plugins subbar.
  // Re-runs when installSpec/installOp/loading change so button state stays current.
  const { setSubbarRight } = useOutletContext<PluginsOutletContext>();
  useEffect(() => {
    setSubbarRight(
      <>
        <div className="flex items-center gap-2">
          <div className="field-wrap">
            <PackageIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              className="field-input w-44"
              placeholder="spec, e.g. numpy==1.26.4"
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
        <Button
          onClick={load}
          variant="ghost"
          size="icon"
          aria-label="Refresh package list"
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </>,
    );
    return () => setSubbarRight(null);
  }, [setSubbarRight, load, loading, installSpec, installOp.busy, handleInstall]);

  return (
    <>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {installOp.error && (
        <p className="text-[11px] text-destructive rounded-md bg-destructive/10 border border-destructive/30 px-2 py-1.5 break-all">
          {installOp.error}
        </p>
      )}
      {installOp.success && (
        <p className="text-[11px] text-success rounded-md bg-success/10 border border-success/20 px-2 py-1.5">
          Install succeeded.
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-row items-center gap-2">
            <div className="flex-1 min-w-0 field-wrap">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                className="field-input"
                placeholder="Search installed packages…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead>Version</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && packages.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-3 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-6 ml-auto rounded" /></TableCell>
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3}>
                  <div className="empty-box">
                    {packages.length === 0
                      ? 'No packages reported by pip.'
                      : 'No packages match your search.'}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p) => {
                const op = uninstallOps[p.name];
                return (
                  <TableRow key={p.name}>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono text-sm text-foreground truncate block cursor-default">
                            {p.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="break-words">{p.name}</TooltipContent>
                      </Tooltip>
                      {op?.error && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="text-[11px] text-destructive font-mono line-clamp-1 cursor-default">
                              {op.error}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs break-words">{op.error}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {p.version}
                    </TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            onClick={() => setDeleteTarget(p)}
                            disabled={op?.busy}
                            variant="ghost"
                            size="icon"
                            className="hover:!text-destructive"
                            aria-label={`Uninstall ${p.name}`}
                          >
                            {op?.busy ? (
                              <Spinner size="md" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Uninstall</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Uninstall package?"
        description={`Runs "pip uninstall -y ${deleteTarget?.name}" on the ComfyUI Python environment. Plugins that depend on it may break.`}
        confirmLabel="Uninstall"
        confirmTone="danger"
        onConfirm={handleUninstall}
      />
    </>
  );
}
