import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { CheckCircle2, MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getNodeIcon, type NodeCategory } from './nodeIcon';
import ProgressRing from './ProgressRing';

export type WfCardStatus = 'neutral' | 'pending' | 'running' | 'done';

// One card shape for both the simple (group) view and the advanced (node)
// view — they only differ in what `label` / `iconClassType` / `category` get
// fed. Extra fields on a node's data (e.g. `memberIds` on a group card) are
// ignored here.
export interface WfCardData {
  label: string;
  category: NodeCategory;
  /** Representative class_type — picks the icon glyph. */
  iconClassType: string;
  status: WfCardStatus;
  /** 0..1 — only while running; undefined ⇒ indeterminate spinner. */
  progressFraction?: number;
}

function WorkflowCard({ data }: { data: WfCardData }) {
  const { label, category, iconClassType, status, progressFraction } = data;
  const Icon = getNodeIcon(iconClassType);
  const isRunning = status === 'running';
  const isDone = status === 'done';

  return (
    <div
      className={cn(
        'wf-card',
        isRunning && 'wf-card--running',
        isDone && 'wf-card--done',
        status === 'pending' && 'wf-card--pending',
      )}
    >
      <Handle type="target" position={Position.Top} className="wf-handle" />

      {isRunning ? (
        <ProgressRing value={progressFraction} />
      ) : (
        <span className={cn('wf-chip', isDone ? 'wf-chip--done' : `wf-chip--${category}`)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      )}

      <span className={cn('wf-title', isDone && 'wf-title--done')} title={label}>
        {label}
      </span>

      {isDone ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-success,#22c55e)]" />
      ) : isRunning ? null : (
        <MoreHorizontal className="h-4 w-4 shrink-0 text-muted-foreground opacity-40" />
      )}

      <Handle type="source" position={Position.Bottom} className="wf-handle" />
    </div>
  );
}

export default memo(WorkflowCard);
