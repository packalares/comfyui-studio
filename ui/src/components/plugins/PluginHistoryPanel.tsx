import { useCallback, useEffect, useState } from 'react';
import {
  History,
  Loader2,
  RefreshCw,
  Trash2,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../../services/comfyui';
import { usePaginated } from '../../hooks/usePaginated';
import Pagination from '../Pagination';
import { formatRelativeTime } from '../../lib/utils';
import type { PluginHistoryEntry } from '../../types';
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
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';

function StatusBadge({ status }: { status: PluginHistoryEntry['status'] }) {
  if (status === 'success') {
    return (
      <Badge variant="emerald">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge variant="teal">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="rose">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return <Badge variant="slate">{status}</Badge>;
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

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <History className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 leading-tight">Plugin operations history</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {loading ? 'Loading…' : total === 0 ? 'No operations yet.' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {total > 0 && (
            <Button
              onClick={() => setClearOpen(true)}
              variant="secondary"
              className="!text-red-600 hover:!bg-red-50"
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
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2">
            <p className="text-xs text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              {error}
            </p>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : total === 0 ? (
          <div className="empty-box">Plugin install / uninstall history will appear here.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((entry) => {
              const when = entry.endTime ?? entry.startTime;
              return (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 px-1 py-2 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {entry.pluginName || entry.pluginId}
                      </p>
                      <span className="text-[11px] text-slate-500 uppercase tracking-wide">
                        {entry.type}
                      </span>
                      <StatusBadge status={entry.status} />
                    </div>
                    <p
                      className="text-[11px] text-slate-500 mt-0.5"
                      title={when ? new Date(when).toLocaleString() : ''}
                    >
                      {when ? formatRelativeTime(when) : '—'}
                      {entry.result && (
                        <>
                          {' · '}
                          <span className="text-slate-600 font-mono truncate">{entry.result}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <Button
                    onClick={() => setDeleteTarget(entry)}
                    variant="ghost"
                    size="icon"
                    className="hover:!text-red-500"
                    title="Remove from history"
                    aria-label="Remove from history"
                    disabled={busy}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Pagination
        page={paged.page}
        pageSize={paged.pageSize}
        total={paged.total}
        hasMore={paged.hasMore}
        onPageChange={paged.setPage}
        onPageSizeChange={paged.setPageSize}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from history?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the history entry for{' '}
              <span className="font-mono text-slate-700">
                {deleteTarget?.pluginName || deleteTarget?.pluginId}
              </span>
              . The underlying plugin on disk is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="!bg-red-600 hover:!bg-red-700">
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all plugin history?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes every entry from plugin operation history. Installed plugins are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearAll} className="!bg-red-600 hover:!bg-red-700">
              <Trash2 className="w-3.5 h-3.5" />
              Clear All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
