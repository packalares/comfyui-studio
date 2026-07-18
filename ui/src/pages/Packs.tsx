import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Trash2, XCircle } from 'lucide-react';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import type { Pack, PackTaskProgress } from '../types';
import { Card, CardHeader } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Spinner } from '../components/ui/spinner';

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Capability Packs</h1>
        <p className="text-sm text-muted-foreground">
          Optional heavy features. Installing a pack downloads its pip
          dependencies and models into the persistent volume and unlocks its
          page elsewhere in the app.
        </p>
      </div>

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
 * Polls `/packs/progress/:taskId` every 1.5s until completed. Mirrors
 * `components/plugins/TaskProgress.tsx`'s polling shape (self-rescheduling
 * setTimeout, not setInterval) but against the pack progress endpoint —
 * pack progress carries a `logs[]` array rather than the plugin history
 * fallback, so there's no separate "persisted logs" endpoint to fall back to.
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await api.getPackProgress(taskId);
        if (cancelled) return;
        setProgress(data);
        setPollError(null);
        if (data.completed && !completedRef.current) {
          completedRef.current = true;
          onCompleteRef.current();
          return;
        }
        if (!data.completed) timer = setTimeout(tick, 1500);
      } catch (err) {
        if (cancelled || completedRef.current) return;
        setPollError(err instanceof Error ? err.message : 'Failed to poll progress');
        timer = setTimeout(tick, 3000);
      }
    };

    tick();
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
