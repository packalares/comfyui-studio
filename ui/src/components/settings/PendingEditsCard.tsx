// Review UI for queued soul-edit proposals submitted by the model.
// The card is invisible when there are no pending edits (returns null), so
// it can be unconditionally mounted above the souls list without leaving a
// gap in normal usage.

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, GitMerge } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Badge } from '../ui/badge';
import { api, type PendingEdit } from '../../services/comfyui';

// Auto-poll interval in milliseconds. 30 s keeps the list fresh without
// hammering a local file-based backend.
const POLL_INTERVAL_MS = 30_000;

// Relative time helper — avoids pulling in date-fns for a single use case.
function relativeTime(unixMs: number): string {
  const diffMs = Date.now() - unixMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

// ---- Per-edit action state ----

interface EditActionState {
  busy: boolean;
  error: string | null;
  // When accept returns ok=false the section no longer matches; surface a Retry.
  sectionMismatch: boolean;
}

// ---- Single pending edit card ----

function PendingEditRow({
  edit,
  onRemove,
  onSoulChanged,
}: {
  edit: PendingEdit;
  onRemove: (id: string) => void;
  onSoulChanged?: () => void;
}) {
  const [state, setState] = useState<EditActionState>({
    busy: false,
    error: null,
    sectionMismatch: false,
  });

  const isAppend = edit.currentSection === null;

  const handleAccept = async () => {
    setState({ busy: true, error: null, sectionMismatch: false });
    try {
      const result = await api.personality.acceptPendingEdit(edit.id);
      if (!result.ok) {
        // The original section was not found in the soul body.
        setState({ busy: false, error: null, sectionMismatch: true });
        return;
      }
      onRemove(edit.id);
      onSoulChanged?.();
    } catch (err) {
      setState({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
        sectionMismatch: false,
      });
    }
  };

  const handleReject = async () => {
    setState({ busy: true, error: null, sectionMismatch: false });
    try {
      await api.personality.rejectPendingEdit(edit.id);
      onRemove(edit.id);
    } catch (err) {
      setState({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
        sectionMismatch: false,
      });
    }
  };

  // Re-fetch the edit in case the soul body changed since we loaded the list,
  // then clear the mismatch so the user can try again with fresh data.
  const handleRetry = async () => {
    setState({ busy: true, error: null, sectionMismatch: false });
    try {
      await api.personality.getPendingEdit(edit.id);
      setState({ busy: false, error: null, sectionMismatch: false });
    } catch (err) {
      setState({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
        sectionMismatch: false,
      });
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* Row header: soul name + timestamp */}
      <div className="flex items-center justify-between gap-3 bg-muted px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs font-semibold text-foreground truncate">
            {edit.soulName}
          </span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            proposed {relativeTime(edit.createdAt)}
          </span>
        </div>
        <Badge variant="slate">
          {isAppend ? 'Append at end' : 'Replace section'}
        </Badge>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* Reason */}
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">Reason:</span>{' '}
          {edit.reason}
        </p>

        {/* Diff view: two columns when replacing, single column when appending */}
        <div className={`grid gap-2 ${isAppend ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {!isAppend && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Current
              </p>
              <pre className="overflow-auto rounded border bg-muted px-2 py-2 font-mono text-[11px] whitespace-pre-wrap break-words text-foreground max-h-48">
                {edit.currentSection}
              </pre>
            </div>
          )}
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Proposed
            </p>
            <pre className="overflow-auto rounded border bg-muted px-2 py-2 font-mono text-[11px] whitespace-pre-wrap break-words text-foreground max-h-48">
              {edit.proposedReplacement}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {state.sectionMismatch && (
            <span className="text-xs text-destructive mr-auto">
              Could not match the original section.{' '}
              <button
                type="button"
                className="underline hover:no-underline"
                onClick={() => void handleRetry()}
              >
                Retry
              </button>
            </span>
          )}
          {state.error && (
            <span className="text-xs text-destructive mr-auto">
              {state.error}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={state.busy}
            onClick={() => void handleReject()}
          >
            {state.busy ? '...' : 'Reject'}
          </Button>
          <Button
            size="sm"
            disabled={state.busy}
            onClick={() => void handleAccept()}
          >
            {state.busy ? '...' : 'Accept'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Public props ----

export interface PendingEditsCardProps {
  /** Called after a successful accept so the parent can refresh its souls list. */
  onSoulChanged?: () => void;
}

// ---- Main card ----

export default function PendingEditsCard({ onSoulChanged }: PendingEditsCardProps) {
  const [edits, setEdits] = useState<PendingEdit[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEdits = useCallback(async () => {
    // Don't throb the loading skeleton on background polls — only on the first
    // fetch and on explicit manual refresh (handled below via setLoading(true)).
    try {
      const result = await api.personality.listPendingEdits();
      setEdits(result.edits);
    } catch (err) {
      // Silently swallow poll errors; the list just stays stale rather than
      // flashing an error on every background tick.
      console.error('PendingEditsCard: fetch failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + start poll on mount. Clear on unmount.
  useEffect(() => {
    void fetchEdits();
    intervalRef.current = setInterval(() => { void fetchEdits(); }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [fetchEdits]);

  const handleManualRefresh = () => {
    setLoading(true);
    void fetchEdits();
  };

  // Remove an edit from local state without a full re-fetch so the list
  // updates instantly after accept/reject without a visible flicker.
  const removeEdit = useCallback((id: string) => {
    setEdits(prev => prev.filter(e => e.id !== id));
  }, []);

  // Empty state: render nothing so the parent layout has no phantom gap.
  if (!loading && edits.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <GitMerge className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">
              Pending soul edits
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Soul-edit proposals queued by the model, waiting for your approval.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!loading && edits.length > 0 && (
            <Badge variant="slate">
              <GitMerge className="h-3 w-3" />
              {edits.length} pending
            </Badge>
          )}
          <ButtonGroup>
            <Button
              variant="secondary"
              onClick={handleManualRefresh}
              disabled={loading}
              aria-label="Refresh pending edits"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </ButtonGroup>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          edits.map(edit => (
            <PendingEditRow
              key={edit.id}
              edit={edit}
              onRemove={removeEdit}
              onSoulChanged={onSoulChanged}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
