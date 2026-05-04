import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  Trash2,
  X,
  History,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Ban,
  Download as DownloadIcon,
} from 'lucide-react';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import { usePaginated } from '../hooks/usePaginated';
import Pagination from './layout/Pagination';
import ConfirmDialog from './modals/ConfirmDialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { Spinner } from './ui/spinner';

type DownloadStatus = 'downloading' | 'success' | 'failed' | 'canceled' | 'queued' | string;

interface DownloadHistoryEntry {
  id: string;
  taskId?: string;
  modelName: string;
  status: DownloadStatus;
  statusText?: string;
  source?: string;
  startTime: number;
  endTime?: number;
  fileSize?: number;
  downloadedSize?: number;
  speed?: number;
  savePath?: string;
  downloadUrl?: string;
  error?: string | null;
  progress?: number;
}

/** Basename of a savePath, with modelName fallback. */
function displayName(entry: DownloadHistoryEntry): string {
  if (entry.savePath) {
    const parts = entry.savePath.split('/');
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  return entry.modelName || entry.id;
}

/** Extract the history array from the raw response regardless of wrapping shape. */
function extractHistory(raw: unknown): DownloadHistoryEntry[] {
  if (!raw) return [];
  const r = raw as Record<string, unknown>;
  // Shape: { items, page, pageSize, total, hasMore } (Phase 8 PageEnvelope)
  if (Array.isArray(r.items)) return r.items as DownloadHistoryEntry[];
  // Legacy shapes kept for back-compat with any lingering callers.
  if (Array.isArray(r.data)) return r.data as DownloadHistoryEntry[];
  if (Array.isArray(r.history)) return r.history as DownloadHistoryEntry[];
  if (r.data && typeof r.data === 'object') {
    const d = r.data as Record<string, unknown>;
    if (Array.isArray(d.history)) return d.history as DownloadHistoryEntry[];
  }
  if (Array.isArray(raw)) return raw as DownloadHistoryEntry[];
  return [];
}

function StatusBadge({ status }: { status: DownloadStatus }) {
  if (status === 'success') {
    return (
      <Badge variant="emerald">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </Badge>
    );
  }
  if (status === 'downloading') {
    return (
      <Badge variant="teal">
        <Spinner size="xs" />
        Downloading
      </Badge>
    );
  }
  if (status === 'queued') {
    return (
      <Badge variant="slate">
        <Spinner size="xs" />
        Queued
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
  if (status === 'canceled') {
    return (
      <Badge variant="slate">
        <Ban className="h-3 w-3" />
        Canceled
      </Badge>
    );
  }
  return (
    <Badge variant="slate">
      {status || 'Unknown'}
    </Badge>
  );
}

function ProgressCell({ downloaded, total, progress }: {
  downloaded?: number;
  total?: number;
  progress?: number;
}) {
  const pct = Math.max(
    0,
    Math.min(
      100,
      typeof progress === 'number' && Number.isFinite(progress)
        ? progress
        : total && downloaded
        ? (downloaded / total) * 100
        : 0,
    ),
  );
  return (
    <div className="w-full">
      <div className="flex justify-between text-[10px] text-slate-500 mb-0.5">
        <span>{Math.round(pct)}%</span>
        {total ? (
          <span className="font-mono">
            {formatBytes(downloaded || 0)} / {formatBytes(total)}
          </span>
        ) : null}
      </div>
      <div className="progress-track">
        <div
          className="progress-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function DownloadsTab() {
  const { downloads } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadHistoryEntry | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const raw = await api.getDownloadHistoryPaged(page, pageSize);
      // The paginated envelope carries items[] at top level; back-compat
      // extractor still runs so shape changes stay resilient.
      const list = extractHistory(raw);
      list.sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
      return { items: list, total: raw.total ?? list.length, hasMore: raw.hasMore ?? false };
    },
    [],
  );

  const paged = usePaginated<DownloadHistoryEntry>(fetcher, { initialPageSize: 25 });
  const { items: entries, loading, refetch } = paged;

  useEffect(() => {
    if (paged.error) setError(paged.error);
  }, [paged.error]);

  // Merge live WS downloads into the displayed rows (by taskId). During an active
  // download the progress bar updates in real time without polling.
  const displayEntries = useMemo(() => {
    return entries.map(entry => {
      const key = entry.taskId || entry.id;
      const live = downloads[key];
      if (!live) return entry;
      return {
        ...entry,
        status: (live.status || entry.status) as DownloadStatus,
        progress: typeof live.progress === 'number' ? live.progress : entry.progress,
        downloadedSize: live.downloadedBytes ?? entry.downloadedSize,
        fileSize: live.totalBytes ?? entry.fileSize,
        error: live.error ?? entry.error,
      };
    });
  }, [entries, downloads]);

  // Event-driven refresh (no polling): when the WS download-map gains a
  // taskId we've never seen on a history row, re-fetch the list once so the
  // new download shows up. In-row progress updates come through the
  // `displayEntries` merge above; terminal state flips come through the same
  // WS message (`completed`/`error`), so polling every 5s is redundant.
  useEffect(() => {
    const knownTaskIds = new Set(entries.map(e => e.taskId || e.id));
    for (const id of Object.keys(downloads)) {
      if (!knownTaskIds.has(id)) { refetch(); return; }
    }
  }, [downloads, entries, refetch]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteDownloadHistoryEntry(deleteTarget.id);
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
      await api.clearDownloadHistory();
      await refetch();
    } catch (err) {
      console.error('Failed to clear history:', err);
      setError('Could not clear history');
    } finally {
      setBusy(false);
      setClearOpen(false);
    }
  }, [refetch]);

  const total = paged.total;

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <History className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 leading-tight">Download History</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {loading
                ? 'Loading…'
                : total === 0
                ? 'No downloads yet.'
                : `${total} ${total === 1 ? 'entry' : 'entries'}`}
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

        {loading && displayEntries.length === 0 ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 rounded-lg bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : displayEntries.length === 0 ? (
          <div className="empty-box">
            <DownloadIcon className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            Your download history will appear here
          </div>
        ) : (
          <>
            {/* Desktop table header */}
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_140px_140px_36px] gap-3 px-3 pb-2 text-[11px] uppercase tracking-wider font-semibold text-slate-500 border-b border-slate-100">
              <span>File</span>
              <span>Status</span>
              <span>Size</span>
              <span>When</span>
              <span>Progress</span>
              <span className="sr-only">Actions</span>
            </div>

            <ul className="divide-y divide-slate-100">
              {displayEntries.map(entry => {
                const isActive = entry.status === 'downloading' || entry.status === 'queued';
                const when = entry.endTime ?? entry.startTime;
                const name = displayName(entry);
                return (
                  <li
                    key={entry.id}
                    className="md:grid md:grid-cols-[minmax(0,1fr)_120px_110px_140px_140px_36px] md:gap-3 md:items-center flex flex-col gap-2 px-3 py-3 hover:bg-slate-50 transition-colors"
                  >
                    {/* File */}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate" title={name}>
                        {name}
                      </p>
                      {entry.modelName && entry.modelName !== name && (
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">
                          {entry.modelName}
                        </p>
                      )}
                      {entry.downloadUrl && (
                        <a
                          href={entry.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-teal-600 hover:text-teal-700 hover:underline truncate mt-0.5 block font-mono"
                          title={entry.downloadUrl}
                        >
                          {entry.downloadUrl}
                        </a>
                      )}
                      {entry.error && (
                        <p className="text-[11px] text-rose-600 truncate mt-0.5" title={entry.error}>
                          {entry.error}
                        </p>
                      )}
                    </div>

                    {/* Status */}
                    <div className="flex md:justify-start">
                      <StatusBadge status={entry.status} />
                    </div>

                    {/* Size */}
                    <div className="text-[11px] text-slate-500 font-mono">
                      {entry.fileSize ? formatBytes(entry.fileSize) : '—'}
                    </div>

                    {/* When */}
                    <div
                      className="text-[11px] text-slate-500"
                      title={when ? new Date(when).toLocaleString() : ''}
                    >
                      {when ? formatRelativeTime(when) : '—'}
                    </div>

                    {/* Progress */}
                    <div>
                      {isActive ? (
                        <ProgressCell
                          downloaded={entry.downloadedSize}
                          total={entry.fileSize}
                          progress={entry.progress}
                        />
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </div>

                    {/* Action */}
                    <div className="flex md:justify-end">
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
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
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

      {/* Delete single entry confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove from history?"
        description={`This removes "${deleteTarget ? displayName(deleteTarget) : ''}" from the download history. The underlying file on disk is not affected.`}
        confirmLabel="Remove"
        confirmTone="danger"
        onConfirm={handleDelete}
      />

      {/* Clear all confirm */}
      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear all download history?"
        description="This removes every entry from your download history. Files already on disk are not affected."
        confirmLabel="Clear All"
        confirmTone="danger"
        onConfirm={handleClearAll}
      />
    </Card>
  );
}
