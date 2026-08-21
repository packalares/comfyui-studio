import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, Settings2, Trash2, XCircle } from 'lucide-react';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePackTaskEvents } from '../services/packEvents';
import type { Pack, PackTaskProgress } from '../types';
import { Card, CardHeader } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Spinner } from '../components/ui/spinner';
import PageSubbar from '../components/layout/PageSubbar';

/**
 * /packs — capability packs (optional heavy features: music generation,
 * LoRA training) install pip deps + models on demand into the persistent
 * volume. Installing a pack is what makes its dedicated page/nav entry show
 * up elsewhere in the app (see `AppSidebar`'s `requiresPack` gate).
 */
export default function Packs() {
  const { refreshPacks } = useApp();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `packId -> taskId` map for in-flight install/uninstall ops. */
  const [tasksByPack, setTasksByPack] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const { items } = await api.getPacks();
      setPacks(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packs');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Mount-time reconciliation: the `packId -> taskId` map only ever lived in
  // React state, so a page refresh mid-install would otherwise abandon the
  // task client-side even though the server is still tracking (and
  // broadcasting) it. `GET /packs/tasks` lists everything still in-flight
  // (or just-completed, within its grace window) so a refresh resumes
  // tracking instead of showing a bare "Install" button over a running job.
  useEffect(() => {
    api.listActivePackTasks()
      .then(({ items }) => {
        if (items.length === 0) return;
        setTasksByPack((prev) => {
          const next = { ...prev };
          for (const t of items) next[t.packId] = t.taskId;
          return next;
        });
      })
      .catch(() => { /* best-effort — worst case, an in-flight install just shows no progress bar */ });
  }, []);

  const onTaskComplete = useCallback(
    (packId: string) => {
      setTimeout(() => {
        void load();
        void refreshPacks();
        setTasksByPack((prev) => {
          const { [packId]: _removed, ...rest } = prev;
          return rest;
        });
      }, 400);
    },
    [load, refreshPacks],
  );

  const handleInstall = useCallback(async (pack: Pack) => {
    try {
      const { taskId } = await api.installPack(pack.id);
      setTasksByPack((prev) => ({ ...prev, [pack.id]: taskId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed');
    }
  }, []);

  const handleUninstall = useCallback(async (pack: Pack) => {
    try {
      const { taskId } = await api.uninstallPack(pack.id);
      setTasksByPack((prev) => ({ ...prev, [pack.id]: taskId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Uninstall failed');
    }
  }, []);

  const installedCount = packs?.filter((p) => p.installed).length ?? 0;

  return (
    <>
      {/* Same page shell every other page uses (see Gallery.tsx / Models.tsx):
          PageSubbar owns the title, then a padded content container. */}
      <PageSubbar
        title="Capability Packs"
        description={
          packs === null
            ? 'Loading…'
            : `${installedCount} of ${packs.length} installed`
        }
      />
      <div className="p-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Optional heavy features. Installing a pack downloads its pip
        dependencies and models into the persistent volume and unlocks its
        page elsewhere in the app.
      </p>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {packs === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              activeTaskId={tasksByPack[pack.id]}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              onTaskComplete={onTaskComplete}
            />
          ))
        )}
      </div>
      </div>
    </>
  );
}

function PackCard({
  pack,
  activeTaskId,
  onInstall,
  onUninstall,
  onTaskComplete,
}: {
  pack: Pack;
  activeTaskId?: string;
  onInstall: (pack: Pack) => void;
  onUninstall: (pack: Pack) => void;
  onTaskComplete: (packId: string) => void;
}) {
  const busy = !!activeTaskId;
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">{pack.label}</h2>
              {pack.installed ? (
                <Badge variant="success">Installed</Badge>
              ) : (
                <Badge variant="neutral">Not installed</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{pack.description}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" asChild>
              <Link to={`/packs/${pack.id}/settings`}>
                <Settings2 className="w-3.5 h-3.5" />
                Configure
              </Link>
            </Button>
            {pack.installed ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => onUninstall(pack)}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Uninstall
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onInstall(pack)}
              >
                <Download className="w-3.5 h-3.5" />
                Install
              </Button>
            )}
          </div>
        </div>
        {activeTaskId && (
          <PackTaskProgressView
            taskId={activeTaskId}
            onComplete={() => onTaskComplete(pack.id)}
          />
        )}
      </CardHeader>
    </Card>
  );
}

/**
 * Tracks one install/uninstall task. The server pushes `{type:'pack:progress',
 * data}` over the shared WS on every state change (`services/packs/
 * install.ts`) — this subscribes to that instead of polling
 * `GET /packs/progress/:taskId` on a fixed interval. The REST endpoint is
 * still used once on mount (reconciliation — covers a task that made
 * progress while this card wasn't mounted yet) and as a fallback poll while
 * the socket is down/reconnecting, so a dropped connection degrades to the
 * old polling behaviour rather than hanging.
 */
function PackTaskProgressView({
  taskId,
  onComplete,
}: {
  taskId: string;
  onComplete: () => void;
}) {
  const [progress, setProgress] = useState<PackTaskProgress | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const { wsConnected } = useApp();
  const wsConnectedRef = useRef(wsConnected);
  wsConnectedRef.current = wsConnected;

  const applyUpdate = useRef((data: PackTaskProgress) => {
    setProgress(data);
    setPollError(null);
    if (data.completed && !completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current();
    }
  });

  usePackTaskEvents(taskId, (data) => applyUpdate.current(data));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async (): Promise<void> => {
      try {
        const data = await api.getPackProgress(taskId);
        if (cancelled) return;
        applyUpdate.current(data);
      } catch (err) {
        if (cancelled || completedRef.current) return;
        setPollError(err instanceof Error ? err.message : 'Failed to poll progress');
      }
    };

    // Reconciliation — always fetch once on mount, regardless of socket
    // state, so a card mounted after the task already made progress (e.g.
    // right after the mount-time `GET /packs/tasks` reconcile above) shows
    // current state immediately instead of waiting for the next push.
    void fetchOnce();

    // Fallback poll — only does real work while the shared WS is down; once
    // it reconnects, push takes back over and this loop goes idle (still
    // ticking, but skipping the network call) until unmount.
    const scheduleFallback = () => {
      if (cancelled || completedRef.current) return;
      timer = setTimeout(() => {
        if (cancelled || completedRef.current) return;
        if (!wsConnectedRef.current) void fetchOnce();
        scheduleFallback();
      }, 1500);
    };
    scheduleFallback();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);

  const pct = Math.max(0, Math.min(100, progress?.progress ?? 0));
  const done = progress?.completed ?? false;
  const success = done && pct >= 100;
  const logs = progress?.logs ?? [];
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : progress?.message ?? 'Starting…';

  return (
    <div className="mt-1 rounded-md border bg-muted px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-[11px] text-foreground">
          {done ? (
            success ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive" />
            )
          ) : (
            <Spinner size="sm" className="text-brand" />
          )}
          <span className="font-medium">{progress?.type ?? 'task'}</span>
          <span className="text-muted-foreground font-mono">{Math.round(pct)}%</span>
        </div>
      </div>
      <div className="h-1 bg-muted rounded-full overflow-hidden mb-1">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            done && !success ? 'bg-destructive' : 'bg-brand'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground font-mono truncate" title={lastLog}>
        {pollError ? pollError : lastLog}
      </p>
    </div>
  );
}
