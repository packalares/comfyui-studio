import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  X,
  History,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Ban,
  Download as DownloadIcon,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import { usePaginated } from '../hooks/usePaginated';
import Pagination from './layout/Pagination';
import PageAside from './layout/PageAside';
import ConfirmDialog from './modals/ConfirmDialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import {
  SelectField,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './forms/SelectField';
import { Spinner } from './ui/spinner';
import type { DownloadState } from '../types';

type DownloadStatus = 'downloading' | 'success' | 'failed' | 'canceled' | 'queued' | string;
type SourceFilter = 'all' | 'comfy' | 'ollama';
type StatusFilter = 'active' | 'queued' | 'recent';
type KindFilter = 'all' | 'lora' | 'checkpoint' | 'llm' | 'other';

// Static option lists for the sidebar SelectFields. Defined module-level so
// every render gets the same array identity (avoids unnecessary remounts of
// Radix Select children).
const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'queued', label: 'Queued' },
  { value: 'recent', label: 'Recent' },
];

const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'comfy', label: 'ComfyUI' },
  { value: 'ollama', label: 'Ollama' },
];

const KIND_OPTIONS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'lora', label: 'LoRA' },
  { value: 'checkpoint', label: 'Checkpoint' },
  { value: 'llm', label: 'LLM' },
  { value: 'other', label: 'Other' },
];

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

function inferSource(entry: DownloadHistoryEntry, live?: DownloadState): SourceFilter {
  if (entry.source === 'ollama') return 'ollama';
  const taskId = entry.taskId || entry.id;
  // Ollama pull taskIds are prefixed with 'pull_' by ollama.ts:makePullId.
  if (taskId.startsWith('pull_')) return 'ollama';
  // Extension fields attached by ollamaPullAdapter.
  if ((live as (DownloadState & { source?: string }) | undefined)?.source === 'ollama') return 'ollama';
  return 'comfy';
}

function inferKind(entry: DownloadHistoryEntry, live?: DownloadState): KindFilter {
  const extKind = (live as (DownloadState & { kind?: string }) | undefined)?.kind;
  if (extKind === 'llm') return 'llm';
  if (entry.source === 'ollama' || (entry.taskId ?? '').startsWith('pull_')) return 'llm';
  const path = (entry.savePath ?? '').toLowerCase();
  if (path.includes('lora')) return 'lora';
  if (path.includes('checkpoint')) return 'checkpoint';
  return 'other';
}

function StatusBadge({ status }: { status: DownloadStatus }) {
  if (status === 'success') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </Badge>
    );
  }
  if (status === 'downloading') {
    return (
      <Badge variant="brand">
        <Spinner size="xs" />
        Downloading
      </Badge>
    );
  }
  if (status === 'queued') {
    return (
      <Badge variant="neutral">
        <Spinner size="xs" />
        Queued
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
  if (status === 'canceled') {
    return (
      <Badge variant="neutral">
        <Ban className="h-3 w-3" />
        Canceled
      </Badge>
    );
  }
  return <Badge variant="neutral">{status || 'Unknown'}</Badge>;
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
      <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
        <span>{Math.round(pct)}%</span>
        {total ? (
          <span className="font-mono">
            {formatBytes(downloaded || 0)} / {formatBytes(total)}
          </span>
        ) : null}
      </div>
      <div className="progress-track">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DownloadRow({
  entry,
  busy,
  onDelete,
}: {
  entry: DownloadHistoryEntry;
  busy: boolean;
  onDelete: (e: DownloadHistoryEntry) => void;
}) {
  const isActive = entry.status === 'downloading' || entry.status === 'queued';
  const when = entry.endTime ?? entry.startTime;
  const name = displayName(entry);
  return (
    <li className="md:grid md:grid-cols-[minmax(0,1fr)_120px_110px_140px_140px_36px] md:gap-3 md:items-center flex flex-col gap-2 px-3 py-3 hover:bg-muted transition-colors">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate" title={name}>{name}</p>
        {entry.modelName && entry.modelName !== name && (
          <p className="text-[11px] text-muted-foreground truncate mt-0.5">{entry.modelName}</p>
        )}
        {entry.downloadUrl && (
          <a
            href={entry.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-brand hover:text-brand/90 hover:underline truncate mt-0.5 block font-mono"
            title={entry.downloadUrl}
          >
            {entry.downloadUrl}
          </a>
        )}
        {entry.error && (
          <p className="text-[11px] text-destructive truncate mt-0.5" title={entry.error}>
            {entry.error}
          </p>
        )}
      </div>
      <div className="flex md:justify-start">
        <StatusBadge status={entry.status} />
      </div>
      <div className="text-[11px] text-muted-foreground font-mono">
        {entry.fileSize ? formatBytes(entry.fileSize) : '—'}
      </div>
      <div className="text-[11px] text-muted-foreground" title={when ? new Date(when).toLocaleString() : ''}>
        {when ? formatRelativeTime(when) : '—'}
      </div>
      <div>
        {isActive ? (
          <ProgressCell downloaded={entry.downloadedSize} total={entry.fileSize} progress={entry.progress} />
        ) : (
          <span className="text-[11px] text-muted-foreground">—</span>
        )}
      </div>
      <div className="flex md:justify-end">
        <Button
          onClick={() => onDelete(entry)}
          variant="ghost"
          size="icon"
          className="hover:!text-destructive"
          title="Remove from history"
          aria-label="Remove from history"
          disabled={busy}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </li>
  );
}

const RECENT_MAX = 10;

export default function DownloadsTab() {
  const { downloads } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadHistoryEntry | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const raw = await api.getDownloadHistoryPaged(page, pageSize);
      const list = raw.items as DownloadHistoryEntry[];
      list.sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
      return { items: list, total: raw.meta.total ?? list.length, hasMore: raw.meta.hasMore ?? false };
    },
    [],
  );

  const paged = usePaginated<DownloadHistoryEntry>(fetcher, { initialPageSize: 25 });
  const { items: entries, loading, refetch } = paged;

  useEffect(() => {
    if (paged.error) setError(paged.error);
  }, [paged.error]);

  // Merge live WS downloads into the displayed rows (by taskId). Progress
  // updates arrive event-driven via WS; no polling needed.
  const allEntries = useMemo(() => {
    const merged = entries.map(entry => {
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

    // Inject live WS entries not yet in history (new downloads that arrived
    // via WS before the history endpoint has a row for them).
    const knownKeys = new Set(entries.map(e => e.taskId || e.id));
    for (const [taskId, live] of Object.entries(downloads)) {
      if (knownKeys.has(taskId)) continue;
      merged.push({
        id: taskId,
        taskId,
        modelName: live.modelName ?? live.filename ?? taskId,
        status: live.status as DownloadStatus,
        progress: live.progress,
        downloadedSize: live.downloadedBytes,
        fileSize: live.totalBytes,
        error: live.error,
        startTime: Date.now(),
        source: (live as DownloadState & { source?: string }).source,
      });
    }
    return merged;
  }, [entries, downloads]);

  // Re-fetch only when a download's status transitions to a terminal state
  // (success / failed / canceled). The old version refetched whenever a live
  // taskId wasn't in `entries` AND depended on `entries` — which made every
  // post-refetch render trigger another refetch, hitting the API on every WS
  // progress tick and eventually 429-ing.
  //
  // Status-transition tracking is enough: the WS feed already powers the
  // live progress display (see allEntries merge above); we only need to hit
  // the history endpoint to durably record terminal rows.
  const seenStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    let needsRefetch = false;
    for (const [id, live] of Object.entries(downloads)) {
      const prev = seenStatusRef.current[id];
      const curr = live.status;
      if (prev === curr) continue;
      seenStatusRef.current[id] = curr;
      if (curr === 'success' || curr === 'failed' || curr === 'canceled') {
        needsRefetch = true;
      }
    }
    if (needsRefetch) refetch();
  }, [downloads, refetch]);

  // Split into Active / Queued / Recent sections then apply filters.
  const liveDownloads = useMemo(
    () => Object.values(downloads),
    [downloads],
  );

  const activeEntries = useMemo(
    () => allEntries.filter(e => e.status === 'downloading'),
    [allEntries],
  );
  const queuedEntries = useMemo(
    () => allEntries.filter(e => e.status === 'queued'),
    [allEntries],
  );
  const recentEntries = useMemo(() => {
    const finished = allEntries.filter(
      e => e.status === 'success' || e.status === 'failed' || e.status === 'canceled',
    );
    finished.sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
    return finished.slice(0, RECENT_MAX);
  }, [allEntries]);

  function applyFilters(list: DownloadHistoryEntry[]): DownloadHistoryEntry[] {
    return list.filter(entry => {
      const live = downloads[entry.taskId || entry.id];
      if (sourceFilter !== 'all' && inferSource(entry, live) !== sourceFilter) return false;
      if (kindFilter !== 'all' && inferKind(entry, live) !== kindFilter) return false;
      return true;
    });
  }

  const filteredActive = applyFilters(activeEntries);
  const filteredQueued = applyFilters(queuedEntries);
  const filteredRecent = applyFilters(recentEntries);

  const visibleEntries = useMemo(() => {
    if (statusFilter === 'active') return filteredActive;
    if (statusFilter === 'queued') return filteredQueued;
    if (statusFilter === 'recent') return filteredRecent;
    return [...filteredActive, ...filteredQueued, ...filteredRecent];
  }, [statusFilter, filteredActive, filteredQueued, filteredRecent]);

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

  const liveCount = liveDownloads.length;
  const total = paged.total;

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* Filter sidebar */}
      <PageAside open={filtersOpen} className="p-4 space-y-5">
        <div>
          <label className="field-label mb-1.5 block">Status</label>
          <SelectField
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter | 'all')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>

        <div>
          <label className="field-label mb-1.5 block">Source</label>
          <SelectField
            value={sourceFilter}
            onValueChange={(v) => setSourceFilter(v as SourceFilter)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>

        <div>
          <label className="field-label mb-1.5 block">Kind</label>
          <SelectField
            value={kindFilter}
            onValueChange={(v) => setKindFilter(v as KindFilter)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>
      </PageAside>

      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Mobile filter toggle */}
        <div className="lg:hidden flex justify-end">
          <Button
            variant="secondary"
            onClick={() => setFiltersOpen(o => !o)}
            aria-label="Toggle filters"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Filters
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              {error}
            </p>
          </div>
        )}

        {/* Active section */}
        {(statusFilter === 'all' || statusFilter === 'active') && filteredActive.length > 0 && (
          <SectionCard
            title="Active"
            count={filteredActive.length}
            icon={<DownloadIcon className="w-3.5 h-3.5 text-brand" />}
          >
            {filteredActive.map(entry => (
              <DownloadRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onDelete={setDeleteTarget}
              />
            ))}
          </SectionCard>
        )}

        {/* Queued section */}
        {(statusFilter === 'all' || statusFilter === 'queued') && filteredQueued.length > 0 && (
          <SectionCard
            title="Queued"
            count={filteredQueued.length}
            icon={<History className="w-3.5 h-3.5 text-muted-foreground" />}
          >
            {filteredQueued.map(entry => (
              <DownloadRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onDelete={setDeleteTarget}
              />
            ))}
          </SectionCard>
        )}

        {/* Recent section */}
        {(statusFilter === 'all' || statusFilter === 'recent') && (
          <Card>
            <CardHeader className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <History className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
                <div>
                  <h2 className="text-sm font-semibold text-foreground leading-tight">
                    Recent
                    {filteredRecent.length > 0 && (
                      <span className="ml-1.5 badge-pill bg-muted text-muted-foreground">
                        {filteredRecent.length}
                      </span>
                    )}
                  </h2>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {loading ? 'Loading...' : total === 0 ? 'No downloads yet.' : `${total} total`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading && filteredRecent.length === 0 ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
                  ))}
                </div>
              ) : filteredRecent.length === 0 ? (
                <div className="empty-box">
                  <DownloadIcon className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                  {liveCount > 0 ? 'Active downloads above.' : 'Completed downloads will appear here.'}
                </div>
              ) : (
                <>
                  <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_140px_140px_36px] gap-3 px-3 pb-2 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground border-b">
                    <span>File</span>
                    <span>Status</span>
                    <span>Size</span>
                    <span>When</span>
                    <span>Progress</span>
                    <span className="sr-only">Actions</span>
                  </div>
                  <ul className="divide-y">
                    {filteredRecent.map(entry => (
                      <DownloadRow
                        key={entry.id}
                        entry={entry}
                        busy={busy}
                        onDelete={setDeleteTarget}
                      />
                    ))}
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
          </Card>
        )}

        {visibleEntries.length === 0 && !loading && (
          <div className="empty-box">
            <DownloadIcon className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
            No downloads match the current filters.
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove from history?"
        description={`This removes "${deleteTarget ? displayName(deleteTarget) : ''}" from the download history. The underlying file on disk is not affected.`}
        confirmLabel="Remove"
        confirmTone="danger"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear all download history?"
        description="This removes every entry from your download history. Files already on disk are not affected."
        confirmLabel="Clear All"
        confirmTone="danger"
        onConfirm={handleClearAll}
      />
    </div>
  );
}

function SectionCard({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center gap-2 py-3">
        {icon}
        <h2 className="text-sm font-semibold text-foreground leading-tight">
          {title}
          <span className="ml-1.5 badge-pill bg-muted text-muted-foreground">{count}</span>
        </h2>
      </CardHeader>
      <CardContent className="p-0">
        <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_140px_140px_36px] gap-3 px-3 pb-2 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground border-b">
          <span>File</span>
          <span>Status</span>
          <span>Size</span>
          <span>When</span>
          <span>Progress</span>
          <span className="sr-only">Actions</span>
        </div>
        <ul className="divide-y">{children}</ul>
      </CardContent>
    </Card>
  );
}
