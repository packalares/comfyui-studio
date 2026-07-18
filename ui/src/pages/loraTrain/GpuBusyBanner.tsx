// "GPU busy: training" affordance for the Train LoRA page — image-LoRA
// training runs on the `oneshot` GPU tenant (see
// server/src/services/gpu/taskTypes.ts), which evicts ollama/comfy/ace-step
// and holds the WHOLE card for the run's duration. Surfacing that here (and
// the fact that anything else queued behind it) is the constraint's
// "GPU-busy affordance" — the same `gpuSnapshot` the sidebar's
// `SchedulerQueueCard` already renders, pushed over the shared WS connection
// (`AppContext.tsx` handles the `{type:'gpu'}` message).

import { Cpu, Clock3 } from 'lucide-react';
import { useApp } from '../../context/AppContext';

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function GpuBusyBanner() {
  const { gpuSnapshot } = useApp();
  const active = gpuSnapshot?.active;
  const queueLength = gpuSnapshot?.queue.length ?? 0;

  if (!active) return null;

  const isThisJob = active.taskType === 'image-lora-train';
  const label = isThisJob
    ? 'GPU busy: LoRA training is holding the whole card'
    : `GPU busy: ${active.taskType} is running — training will start once it finishes`;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <Cpu className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{label}</span>
      <span className="flex items-center gap-1 text-amber-600/80 dark:text-amber-400/80">
        <Clock3 className="h-3 w-3" />
        {formatElapsed(active.startedAt)}
      </span>
      {queueLength > 0 && (
        <span className="rounded-full bg-amber-500/20 px-1.5 py-px font-mono text-[10px]">
          +{queueLength} queued
        </span>
      )}
    </div>
  );
}
