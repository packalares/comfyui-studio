// In-card pull-progress widget — shared by the Library and HuggingFace
// cards so both surfaces render the SAME spinner/percent/bytes UI. Pulled
// out of OllamaModelsPanel.tsx (Bug-fix: HF cards used to fire a pull and
// then silently show nothing — users had to switch to the Downloads tab
// to see status).
//
// Pure presentation: state lives in the parent panel which tracks every
// in-flight pull in a name-keyed `Record<string, PullState>` and hands the
// matching slice down to whichever card is active.

import { formatBytes, type PullState } from './shared';

export function PullProgress({ pull }: { pull: PullState }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="truncate">
          {pull.status || 'pulling'}
          {pull.digest ? ` · ${pull.digest.slice(0, 12)}` : ''}
        </span>
        <span>{pull.percent}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-brand transition-all"
          style={{ width: `${pull.percent}%` }}
        />
      </div>
      {pull.total ? (
        <div className="text-[10px] text-muted-foreground">
          {formatBytes(pull.completed ?? 0)} / {formatBytes(pull.total)}
        </div>
      ) : null}
    </div>
  );
}
