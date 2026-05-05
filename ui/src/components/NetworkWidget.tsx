import { Globe } from 'lucide-react';
import { Card } from './ui/card';
import { Spinner } from './ui/spinner';
import { useApp } from '../context/AppContext';
import type { NetworkReachability } from '../services/comfyui';

const ROWS = [
  { key: 'github', label: 'GitHub' },
  { key: 'huggingface', label: 'HuggingFace' },
  { key: 'pip', label: 'pip' },
] as const;

const stateOf = (r?: NetworkReachability): 'ok' | 'fail' | 'unknown' => {
  if (!r || (r.latencyMs == null && !r.accessible)) return 'unknown';
  return r.accessible ? 'ok' : 'fail';
};

export default function NetworkWidget() {
  const { network: cfg } = useApp();
  const loading = cfg === null;

  const states = ROWS.map(r => stateOf(cfg?.reachability?.[r.key]));
  const fails = states.filter(s => s === 'fail').length;
  const unknowns = states.filter(s => s === 'unknown').length;
  const summary = loading
    ? 'Checking…'
    : !cfg
      ? 'Unavailable'
      : unknowns === states.length
        ? 'Checking…'
        : fails === 0
          ? 'All reachable'
          : `${fails} unreachable`;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-success/10">
          <Globe className="w-3.5 h-3.5 text-success" />
        </div>
        <h3 className="stat-label">Network</h3>
        <span className="ml-auto text-[11px] text-muted-foreground flex items-center gap-1.5">
          {loading && <Spinner size="xs" className="text-muted-foreground" />}
          {summary}
        </span>
      </div>
      <ul className="space-y-1.5">
        {ROWS.map((row, i) => {
          const r = cfg?.reachability?.[row.key];
          const s = states[i];
          const cls = s === 'ok' ? 'bg-success' : s === 'fail' ? 'bg-destructive' : 'bg-warning';
          return (
            <li key={row.key} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-foreground">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
                {row.label}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {r?.latencyMs != null ? `${r.latencyMs} ms` : s === 'unknown' ? '—' : 'offline'}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
