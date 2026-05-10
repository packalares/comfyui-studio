import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getNodeIcon, CATEGORY_STYLE, type NodeCategory } from './nodeIcon';
import type { NodeStatus } from './useNodeStatusMap';

export interface WorkflowNodeData {
  label: string;
  classType: string;
  category: NodeCategory;
  status: NodeStatus;
  progressValue?: number;
  progressMax?: number;
}

function WorkflowNode({ data }: { data: WorkflowNodeData }) {
  const { label, classType, category, status, progressValue, progressMax } = data;
  const Icon = getNodeIcon(classType);

  const isRunning = status === 'running';
  const isDone = status === 'done';
  const catStyle = CATEGORY_STYLE[category];

  // Color comes from the category (Models / Inputs / Prompts / Sampling /
  // Output / Other) so the user can see at a glance which stage each node
  // belongs to. Running overrides with the editor-style green border + glow.
  const containerClass = cn(
    'relative flex items-center gap-2 px-3 py-2 rounded-xl transition-colors duration-300 select-none',
    'min-w-[160px] max-w-[220px] shadow-sm',
    isRunning
      ? 'border-2 border-[var(--color-success)] bg-[color-mix(in_srgb,var(--color-success)_8%,var(--color-card))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_28%,transparent)]'
      : `border ${catStyle.bg} ${catStyle.border}`,
  );

  const iconClass = cn(
    'w-4 h-4 shrink-0',
    isRunning ? 'text-[var(--color-success)]' : catStyle.label,
  );

  const textClass = cn(
    'text-[11px] font-medium truncate leading-tight',
    isDone ? 'text-[var(--color-muted-foreground)]' : 'text-[var(--color-foreground)]',
  );

  const hasProgress =
    isRunning &&
    progressMax != null &&
    progressMax > 0 &&
    progressValue != null;

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Top} className="!w-1.5 !h-1.5 !border-0 !bg-[var(--color-border)]" />

      <Icon className={iconClass} />

      <span className={textClass} title={label}>{label}</span>

      {isDone && (
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[var(--color-success,#22c55e)] ml-auto" />
      )}

      {/* Sub-progress bar at the bottom edge (matches the running green). */}
      {hasProgress && (
        <div
          className="absolute bottom-0 left-0 h-[2px] rounded-full bg-[var(--color-success)] transition-all duration-150"
          style={{ width: `${Math.round((progressValue! / progressMax!) * 100)}%` }}
        />
      )}

      <Handle type="source" position={Position.Bottom} className="!w-1.5 !h-1.5 !border-0 !bg-[var(--color-border)]" />
    </div>
  );
}

export default memo(WorkflowNode);
