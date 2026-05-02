import { useEffect, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';
import { api } from '../services/comfyui';
import { Card } from './ui/card';

/**
 * Mirror of the backend `NetworkConfigView` in
 * server/src/services/systemLauncher/system.service.ts. Kept locally because
 * `api.getNetworkConfig` still returns `Record<string, unknown>`.
 */
interface Reachability { url: string; accessible: boolean; latencyMs?: number }
interface NetworkConfigView {
  huggingfaceEndpoint: string;
  githubProxy: string;
  pipSource: string;
  pluginTrustedHosts: string[];
  allowPrivateIpMirrors: boolean;
  reachability: { github: Reachability; pip: Reachability; huggingface: Reachability };
}

const ROWS = [
  { key: 'github', label: 'GitHub' },
  { key: 'huggingface', label: 'HuggingFace' },
  { key: 'pip', label: 'pip' },
] as const;

const stateOf = (r?: Reachability): 'ok' | 'fail' | 'unknown' => {
  if (!r || (r.latencyMs == null && !r.accessible)) return 'unknown';
  return r.accessible ? 'ok' : 'fail';
};

export default function NetworkWidget() {
  const [cfg, setCfg] = useState<NetworkConfigView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const fetchOnce = async (isRetry: boolean) => {
      try {
        const raw = (await api.getNetworkConfig()) as Record<string, unknown>;
        const data = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as NetworkConfigView;
        if (cancelled) return;
        setCfg(data);
        setLoading(false);
        const r = data?.reachability;
        const neverChecked = !!r && [r.github, r.pip, r.huggingface].every(x => !x?.accessible && x?.latencyMs == null);
        if (!isRetry && neverChecked) retry = setTimeout(() => fetchOnce(true), 3500);
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    fetchOnce(false);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, []);

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
        <div className="p-1.5 rounded-md bg-emerald-50">
          <Globe className="w-3.5 h-3.5 text-emerald-600" />
        </div>
        <h3 className="stat-label">Network</h3>
        <span className="ml-auto text-[11px] text-slate-500 flex items-center gap-1.5">
          {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
          {summary}
        </span>
      </div>
      <ul className="space-y-1.5">
        {ROWS.map((row, i) => {
          const r = cfg?.reachability?.[row.key];
          const s = states[i];
          const cls = s === 'ok' ? 'bg-emerald-500' : s === 'fail' ? 'bg-rose-500' : 'bg-amber-400';
          return (
            <li key={row.key} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-700">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
                {row.label}
              </span>
              <span className="text-[11px] tabular-nums text-slate-500">
                {r?.latencyMs != null ? `${r.latencyMs} ms` : s === 'unknown' ? '—' : 'offline'}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
