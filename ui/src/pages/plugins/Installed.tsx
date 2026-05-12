import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  RefreshCw,
  Plus,
  Search,
  AlertTriangle,
} from 'lucide-react';
import type { PluginsOutletContext } from '../Plugins';
import { api } from '../../services/comfyui';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePaginated } from '../../hooks/usePaginated';
import Pagination from '../../components/layout/Pagination';
import type { Plugin } from '../../types';
import PluginRow from '../../components/plugins/PluginRow';
import InstallUrlModal from '../../components/plugins/InstallUrlModal';
import SwitchVersionModal from '../../components/plugins/SwitchVersionModal';
import { Button } from '../../components/ui/button';
import { Card, CardHeader } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import ConfirmDialog from '../../components/modals/ConfirmDialog';

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

  // Render this page's actions into the shared Plugins subbar (Refresh +
  // Install from URL). Re-runs when `refreshing` flips so the button's
  // disabled/spinner state stays current; cleared on unmount / route change.
  const { setSubbarRight } = useOutletContext<PluginsOutletContext>();
  useEffect(() => {
    setSubbarRight(
      <>
        <Button
          onClick={handleRefresh}
          disabled={refreshing}
          variant="secondary"
          title="Pull latest plugin catalog from registry + re-scan installed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button onClick={() => setUrlModalOpen(true)}>
          <Plus className="w-3.5 h-3.5" />
          Install from URL
        </Button>
      </>,
    );
    return () => setSubbarRight(null);
  }, [setSubbarRight, handleRefresh, refreshing]);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {/* List */}
      <Card>
        <CardHeader>
          <div className="flex flex-row items-center gap-2">
            <div className="flex-1 min-w-0 field-wrap">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search plugins by name, author, or tag…"
                className="field-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div role="tablist" aria-label="Plugin filter" className="tab-strip shrink-0">
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
                  className={`tab-strip-item ${filter === key ? 'is-active' : ''}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plugin</TableHead>
              <TableHead>Author</TableHead>
              <TableHead className="text-right">Stars</TableHead>
              <TableHead>Installed</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && plugins.length === 0 ? (
              Array.from({ length: 7 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="h-6 w-6 rounded shrink-0" />
                      <div className="space-y-1.5 flex-1">
                        <Skeleton className="h-3 w-32" />
                        <Skeleton className="h-2.5 w-48" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-8 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : plugins.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="empty-box">
                    {total === 0 && !search && filter === 'all'
                      ? 'Plugin catalog is empty.'
                      : 'No plugins match your search.'}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              plugins.map((p) => (
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
              ))
            )}
          </TableBody>
        </Table>
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          hasMore={paged.hasMore}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
        />
      </Card>

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

      <ConfirmDialog
        open={!!uninstallTarget}
        onClose={() => setUninstallTarget(null)}
        title="Uninstall plugin?"
        description={`This removes "${uninstallTarget?.name || uninstallTarget?.id || ''}" from custom_nodes/. You can re-install it from the catalog later.`}
        confirmLabel="Uninstall"
        confirmTone="danger"
        onConfirm={handleUninstall}
      />
    </div>
  );
}
