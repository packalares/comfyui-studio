import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  RefreshCw,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { Spinner } from '../ui/spinner';
import { api } from '../../services/comfyui';
import { usePaginated } from '../../hooks/usePaginated';
import Pagination from '../layout/Pagination';
import { formatRelativeTime } from '../../lib/utils';
import type { PluginHistoryEntry } from '../../types';
import type { PluginsOutletContext } from '../../pages/Plugins';
import ConfirmDialog from '../modals/ConfirmDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

function StatusBadge({ status }: { status: PluginHistoryEntry['status'] }) {
  if (status === 'success') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge variant="brand">
        <Spinner size="xs" />
        Running
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="danger">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return <Badge variant="neutral">{status}</Badge>;
}

export default function PluginHistoryPanel() {
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PluginHistoryEntry | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const res = await api.getPluginHistoryPaged(page, pageSize);
      return { items: res.items, total: res.total, hasMore: res.hasMore };
    },
    [],
  );

  const paged = usePaginated<PluginHistoryEntry>(fetcher, { initialPageSize: 25 });
  const { items: entries, total, loading, refetch } = paged;

  useEffect(() => {
    if (paged.error) setError(paged.error);
  }, [paged.error]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deletePluginHistoryEntry(deleteTarget.id);
      await refetch();
    } catch (err) {
      console.error('Failed to delete history entry:', err);
      setError('Could not delete entry');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, refetch]);

  const handleClearAll = useCallback(async () => {
    setBusy(true);
    try {
      await api.clearPluginHistory();
      await refetch();
    } catch (err) {
      console.error('Failed to clear plugin history:', err);
      setError('Could not clear history');
    } finally {
      setBusy(false);
      setClearOpen(false);
    }
  }, [refetch]);

  // This page's actions live in the shared Plugins subbar (Clear All +
  // Refresh). Re-runs as count / busy / loading change so the buttons'
  // visibility and disabled state stay current; cleared on route change.
  const { setSubbarRight } = useOutletContext<PluginsOutletContext>();
  useEffect(() => {
    setSubbarRight(
      <>
        {total > 0 && (
          <Button
            onClick={() => setClearOpen(true)}
            variant="secondary"
            className="!text-destructive hover:!bg-destructive/10"
            disabled={busy}
            title="Clear all entries"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear All
          </Button>
        )}
        <Button
          onClick={() => refetch()}
          variant="ghost"
          size="icon"
          title="Refresh"
          aria-label="Refresh"
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </>,
    );
    return () => setSubbarRight(null);
  }, [setSubbarRight, refetch, total, busy, loading]);

  return (
    <>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plugin</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && entries.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                  </TableCell>
                  <TableCell><Skeleton className="h-3 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-6 ml-auto rounded" /></TableCell>
                </TableRow>
              ))
            ) : total === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="empty-box">Plugin install / uninstall history will appear here.</div>
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => {
                const when = entry.endTime ?? entry.startTime;
                return (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm font-medium text-foreground truncate block cursor-default">
                              {entry.pluginName || entry.pluginId}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="break-words">
                            {entry.pluginName || entry.pluginId}
                          </TooltipContent>
                        </Tooltip>
                        {entry.result && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-[11px] text-muted-foreground font-mono line-clamp-1 cursor-default">
                                {entry.result}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs break-words">
                              {entry.result}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {entry.type}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {when ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">{formatRelativeTime(when)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{new Date(when).toLocaleString()}</TooltipContent>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell><StatusBadge status={entry.status} /></TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            onClick={() => setDeleteTarget(entry)}
                            variant="ghost"
                            size="icon"
                            className="hover:!text-destructive"
                            aria-label="Remove from history"
                            disabled={busy}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove from history</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })
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

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove from history?"
        description={`Removes the history entry for "${deleteTarget?.pluginName || deleteTarget?.pluginId || ''}". The underlying plugin on disk is not affected.`}
        confirmLabel="Remove"
        confirmTone="danger"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear all plugin history?"
        description="Removes every entry from plugin operation history. Installed plugins are not affected."
        confirmLabel="Clear All"
        confirmTone="danger"
        onConfirm={handleClearAll}
      />
    </>
  );
}
