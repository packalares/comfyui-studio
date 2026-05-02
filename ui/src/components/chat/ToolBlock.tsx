import { useState } from 'react';
import { Wrench, ChevronRight, AlertCircle, Check } from 'lucide-react';
import type { ChatToolPart } from '../../services/chatEvents';
import { Badge } from '../ui/badge';

interface Props {
  part: ChatToolPart;
}

// A persisted assistant message part might come back from the server with
// loose `unknown` typing; this guard narrows it down.
export function isToolPart(value: unknown): value is ChatToolPart {
  if (!value || typeof value !== 'object') return false;
  const p = value as { type?: unknown; toolName?: unknown };
  return p.type === 'tool-invocation' && typeof p.toolName === 'string';
}

function shortArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args.length > 60 ? args.slice(0, 57) + '...' : args;
  try {
    const json = JSON.stringify(args);
    return json.length > 60 ? json.slice(0, 57) + '...' : json;
  } catch {
    return '';
  }
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function ToolBlock({ part }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isError = part.state === 'error';
  // Reuse shadcn `<Badge>` with Studio's emerald/rose variants so tool chips
  // match the rest of the visual language without new primitives.
  const badgeVariant: 'rose' | 'emerald' = isError ? 'rose' : 'emerald';
  const headerLabel = isError ? 'Tool error' : 'Tool';
  const summary = shortArgs(part.args);

  return (
    <div className="my-2 rounded-md border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-3 w-3 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Badge variant={badgeVariant}>
          {isError ? <AlertCircle className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
          {headerLabel}
        </Badge>
        <code className="font-mono text-slate-700">{part.toolName}</code>
        {summary && (
          <span className="truncate text-slate-500">{summary}</span>
        )}
        {!isError && (
          <Check className="ml-auto h-3 w-3 shrink-0 text-emerald-500" />
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-slate-200 px-2.5 py-2 text-xs">
          <div>
            <div className="mb-0.5 font-medium text-slate-600">Arguments</div>
            <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-slate-800 whitespace-pre-wrap break-words">{pretty(part.args)}</pre>
          </div>
          {isError ? (
            <div>
              <div className="mb-0.5 font-medium text-rose-700">Error</div>
              <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-rose-700 whitespace-pre-wrap break-words">{part.errorMessage ?? 'Unknown error'}</pre>
            </div>
          ) : (
            <div>
              <div className="mb-0.5 font-medium text-slate-600">Result</div>
              <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-slate-800 whitespace-pre-wrap break-words">{pretty(part.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
