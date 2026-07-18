// Training job list + live progress/log tail for the selected job. Polls
// `GET /ai-toolkit/jobs` for the list and `GET /ai-toolkit/jobs/:id/logs`
// for the selected job's log ring buffer while it's queued/running.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge, type BadgeVariant } from '../../components/ui/badge';
import { cn } from '../../lib/utils';
import * as api from '../../services/aiToolkit';
import type { AiToolkitJob, AiToolkitJobStatus } from '../../services/aiToolkit';

const STATUS_META: Record<AiToolkitJobStatus, { label: string; variant: BadgeVariant; icon: typeof Clock }> = {
  queued: { label: 'Queued', variant: 'neutral', icon: Clock },
  running: { label: 'Running', variant: 'brand', icon: Loader2 },
  succeeded: { label: 'Succeeded', variant: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', variant: 'neutral', icon: Ban },
};

const LIST_POLL_MS = 3000;
const LOG_POLL_MS = 2000;

interface JobsPanelProps {
  /** Bumped by the parent after a new job is started, to force an immediate refresh. */
  refreshSignal: number;
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
}

export default function JobsPanel({ refreshSignal, selectedJobId, onSelectJob }: JobsPanelProps) {
  const [jobs, setJobs] = useState<AiToolkitJob[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const logScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const items = await api.listTrainingJobs(50);
        if (!cancelled) setJobs(items);
      } catch {
        // transient — keep the last known list rather than flashing an error
        // on every missed poll.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), LIST_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [refreshSignal]);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const isLive = selectedJob?.status === 'queued' || selectedJob?.status === 'running';

  useEffect(() => {
    if (!selectedJobId) { setLogs([]); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const lines = await api.getTrainingJobLogs(selectedJobId);
        if (!cancelled) setLogs(lines);
      } catch {
        // transient
      }
    };
    void tick();
    if (!isLive) return () => { cancelled = true; };
    const id = setInterval(() => void tick(), LOG_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedJobId, isLive]);

  useEffect(() => {
    logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
  }, [logs]);

  const handleCancel = async () => {
    if (!selectedJobId) return;
    setCancelling(true);
    try {
      await api.cancelTrainingJob(selectedJobId);
      toast.success('Cancel requested');
    } catch (err) {
      toast.error('Failed to cancel', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Training jobs</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {jobs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No training jobs yet.</p>
          ) : (
            jobs.map((job) => {
              const meta = STATUS_META[job.status];
              const Icon = meta.icon;
              const active = job.id === selectedJobId;
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => onSelectJob(job.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                    active ? 'border border-brand/30 bg-brand/10' : 'border border-transparent hover:bg-muted',
                  )}
                >
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', job.status === 'running' && 'animate-spin')} />
                  <span className="flex-1 truncate font-medium text-foreground">{job.name}</span>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      {selectedJob && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="truncate">{selectedJob.name}</CardTitle>
            {(selectedJob.status === 'queued' || selectedJob.status === 'running') && (
              <Button variant="destructive" size="sm" onClick={() => void handleCancel()} disabled={cancelling}>
                <Ban className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Base model: <span className="text-foreground">{selectedJob.baseModel}</span></div>
              <div>Dataset: <span className="text-foreground">{selectedJob.datasetName ?? '—'}</span></div>
            </div>

            {(selectedJob.status === 'running' || selectedJob.status === 'succeeded') && (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Step {selectedJob.step}/{selectedJob.totalSteps || '?'}</span>
                  <span>{Math.round(selectedJob.progress)}%</span>
                </div>
                <div className="progress-track h-1.5">
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, selectedJob.progress))}%` }}
                  />
                </div>
              </div>
            )}

            {selectedJob.status === 'failed' && selectedJob.error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{selectedJob.error}</p>
            )}

            {selectedJob.status === 'succeeded' && selectedJob.outputFilename && (
              <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                Installed as <span className="font-mono">{selectedJob.outputFilename}</span> in ComfyUI&apos;s loras folder — ready to use in Studio.
              </p>
            )}

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Log</div>
              <div ref={logScrollRef} className="h-56 overflow-y-auto rounded-lg border border-border bg-muted/40 p-2">
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                  {logs.length > 0 ? logs.join('\n') : 'No log output yet.'}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
