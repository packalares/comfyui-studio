import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Plus,
  Search,
  Loader2,
  AlertTriangle,
  Package as PackageIcon,
} from 'lucide-react';
import { api } from '../../services/comfyui';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePaginated } from '../../hooks/usePaginated';
import Pagination from '../../components/Pagination';
import type { Plugin } from '../../types';
import PluginRow from '../../components/plugins/PluginRow';
import InstallUrlModal from '../../components/plugins/InstallUrlModal';
import SwitchVersionModal from '../../components/plugins/SwitchVersionModal';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../../components/ui/alert-dialog';

type StatusFilter = 'all' | 'installed' | 'available';

/**
 * /plugins/installed — plugin list + filters + "Install from URL" / "Refresh"
 * actions. The catalog is fetched server-paginated so we don't ship ~2900
 * rows at once; filters (search / installed / available) are passed to the
 * backend so they apply across pages. Refresh now also pulls a fresh catalog
 * from the upstream registry before re-scanning installed plugins.
 */
export default function Installed() {
  const [search, setSearch] = usePersistedState('plugins.search', '');
  const [filter, setFilter] = usePersistedState<StatusFilter>('plugins.filter', 'all');
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<Plugin | null>(null);
  const [switchTarget, setSwitchTarget] = useState<Plugin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forceTick, setForceTick] = useState(0);

  /** `pluginId -> taskId` map for in-flight ops. Shown inline in each row. */
  const [tasksByPlugin, setTasksByPlugin] = useState<Record<string, string>>({});

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const res = await api.getPluginsPaged(page, pageSize, {
        forceRefresh: forceTick > 0,
        q: search.trim() || undefined,
        filter,
      });
      return { items: res.items, total: res.total, hasMore: res.hasMore };
    },
    [search, filter, forceTick],
  );

  const paged = usePaginated<Plugin>(fetcher, { deps: [search, filter, forceTick] });
  const { items: plugins, total, loading, refetch } = paged;

  useEffect(() => {
    if (paged.error) setError(paged.error);
  }, [paged.error]);

  const onTaskComplete = useCallback(
    (pluginId: string, _success: boolean) => {
      setTimeout(() => {
        refetch().catch(() => { /* handled inside */ });
        setTasksByPlugin((prev) => {
          const { [pluginId]: _removed, ...rest } = prev;
          return rest;
        });
      }, 400);
    },
    [refetch],
  );

  const handleInstall = useCallback(async (plugin: Plugin) => {
    try {
      const r = await api.installPlugin(plugin.id);
      setTasksByPlugin((prev) => ({ ...prev, [plugin.id]: r.taskId }));
    } catch (err) {
      console.error('Install failed:', err);
      setError(err instanceof Error ? err.message : 'Install failed');
    }
  }, []);

  const handleUninstall = useCallback(async () => {
    if (!uninstallTarget) return;
    const p = uninstallTarget;
    setUninstallTarget(null);
    try {
      const r = await api.uninstallPlugin(p.id);
      setTasksByPlugin((prev) => ({ ...prev, [p.id]: r.taskId }));
    } catch (err) {
      console.error('Uninstall failed:', err);
      setError(err instanceof Error ? err.message : 'Uninstall failed');
    }
  }, [uninstallTarget]);

  const handleToggle = useCallback(async (plugin: Plugin, enable: boolean) => {
    try {
      const r = enable ? await api.enablePlugin(plugin.id) : await api.disablePlugin(plugin.id);
      setTasksByPlugin((prev) => ({ ...prev, [plugin.id]: r.taskId }));
    } catch (err) {
      console.error('Toggle failed:', err);
      setError(err instanceof Error ? err.message : 'Toggle failed');
    }
  }, []);

  const handleSwitchVersion = useCallback(
    async (plugin: Plugin, target: { id?: string; version?: string }) => {
      const r = await api.switchPluginVersion(plugin.id, target);
      setTasksByPlugin((prev) => ({ ...prev, [plugin.id]: r.taskId }));
    },
    [],
  );

  const handleInstallCustom = useCallback(
    async (url: string, branch: string) => {
      const r = await api.installPluginCustom(url, branch || undefined);
      if (r.pluginId) {
        setTasksByPlugin((prev) => ({ ...prev, [r.pluginId]: r.taskId }));
      }
      setTimeout(() => refetch().catch(() => { /* ignored */ }), 500);
    },
    [refetch],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.refreshPlugins();
      setForceTick((t) => t + 1);
      await refetch();
    } catch (err) {
      console.error('Refresh failed:', err);
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  // `total` reflects the filtered count globally; for the "Installed · N"
  // badge we approximate from the current page when viewing All.
  const installedOnPage = useMemo(
    () => plugins.filter((p) => p.installed).length,
    [plugins],
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel">
        <div className="flex flex-col md:flex-row md:items-center gap-2 p-3">
          <div className="flex-1 field-wrap">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Search plugins by name, author, or tag…"
              className="field-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div
            role="tablist"
            aria-label="Plugin filter"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1"
          >
            {(
              [
                ['all', 'All'],
                ['installed', filter === 'installed' ? `Installed · ${total}` : 'Installed'],
                ['available', 'Available'],
              ] as [StatusFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                  filter === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="btn-secondary"
              title="Pull latest plugin catalog from registry + re-scan installed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={() => setUrlModalOpen(true)} className="btn-primary">
              <Plus className="w-3.5 h-3.5" />
              Install from URL
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 flex items-center gap-2 text-xs text-rose-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {/* List */}
      <section className="panel">
        <div className="panel-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PackageIcon className="w-3.5 h-3.5 text-slate-400" />
            <h2 className="panel-header-title">
              Plugins ({plugins.length} of {total})
              {filter === 'all' && installedOnPage > 0 && (
                <span className="text-slate-400 font-normal"> · {installedOnPage} installed on this page</span>
              )}
            </h2>
          </div>
        </div>
        {loading && plugins.length === 0 ? (
          <div className="panel-body flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
          </div>
        ) : plugins.length === 0 ? (
          <div className="panel-body">
            <div className="empty-box">
              {total === 0 && !search && filter === 'all'
                ? 'Plugin catalog is empty.'
                : 'No plugins match your search.'}
            </div>
          </div>
        ) : (
          <div className="max-h-[640px] overflow-y-auto scrollbar-subtle">
            {plugins.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                activeTaskId={tasksByPlugin[p.id]}
                onInstall={handleInstall}
                onUninstall={setUninstallTarget}
                onToggle={handleToggle}
                onSwitchVersion={setSwitchTarget}
                onTaskComplete={onTaskComplete}
              />
            ))}
          </div>
        )}
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          hasMore={paged.hasMore}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
        />
      </section>

      <InstallUrlModal
        open={urlModalOpen}
        onClose={() => setUrlModalOpen(false)}
        onSubmit={handleInstallCustom}
        title="Install plugin from URL"
        urlLabel="Repository URL"
        urlPlaceholder="https://github.com/owner/repo"
        showBranch={true}
      />

      <SwitchVersionModal
        plugin={switchTarget}
        onClose={() => setSwitchTarget(null)}
        onConfirm={handleSwitchVersion}
      />

      <AlertDialog
        open={!!uninstallTarget}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall plugin?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes{' '}
              <span className="font-mono text-slate-700">
                {uninstallTarget?.name || uninstallTarget?.id}
              </span>{' '}
              from <code className="font-mono text-slate-700">custom_nodes/</code>. You can
              re-install it from the catalog later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUninstall} className="!bg-red-600 hover:!bg-red-700">
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
