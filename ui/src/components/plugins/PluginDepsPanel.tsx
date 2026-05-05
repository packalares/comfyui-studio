import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Wrench,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { api } from '../../services/comfyui';
import type { PluginDependencyReport } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Spinner } from '../ui/spinner';

interface OpState {
  busy: boolean;
  error?: string;
  output?: string;
  success?: boolean;
}

/**
 * Per-plugin requirements.txt scan with inline "Fix deps" action that
 * runs pip install against the ComfyUI python env.
 */
export default function PluginDepsPanel() {
  const [reports, setReports] = useState<PluginDependencyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ops, setOps] = useState<Record<string, OpState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getPluginPythonDeps();
      setReports(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugin dependencies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const fixDeps = useCallback(
    async (plugin: string) => {
      setOps((prev) => ({ ...prev, [plugin]: { busy: true } }));
      try {
        const r = await api.fixPluginPythonDeps(plugin);
        setOps((prev) => ({
          ...prev,
          [plugin]: { busy: false, success: true, output: r.output },
        }));
        load();
      } catch (err) {
        setOps((prev) => ({
          ...prev,
          [plugin]: {
            busy: false,
            success: false,
            error: err instanceof Error ? err.message : 'Fix failed',
          },
        }));
      }
    },
    [load],
  );

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Wrench className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">Plugin dependencies</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Per-plugin <code className="font-mono">requirements.txt</code> status.
            </p>
          </div>
        </div>
        <Button
          onClick={load}
          variant="ghost"
          size="icon"
          title="Refresh"
          disabled={loading}
          aria-label="Refresh dependency report"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-2">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner size="lg" className="text-muted-foreground" />
          </div>
        ) : reports.length === 0 ? (
          <div className="empty-box">No plugins installed.</div>
        ) : (
          <ul className="divide-y">
            {reports.map((r) => {
              const missing = r.missingDeps.length;
              const depCount = r.dependencies.length;
              const op = ops[r.plugin];
              const open = expanded[r.plugin];
              const status: {
                label: string;
                variant: 'emerald' | 'amber';
                icon: JSX.Element;
              } = missing === 0
                ? { label: 'OK', variant: 'emerald', icon: <CheckCircle2 className="w-3 h-3" /> }
                : {
                    label: `${missing} missing`,
                    variant: 'amber',
                    icon: <AlertTriangle className="w-3 h-3" />,
                  };
              return (
                <li key={r.plugin} className="py-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setExpanded((e) => ({ ...e, [r.plugin]: !e[r.plugin] }))}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      aria-label={open ? 'Collapse' : 'Expand'}
                      disabled={depCount === 0}
                    >
                      {open ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">{r.plugin}</p>
                        <span className="text-[11px] text-muted-foreground">{depCount} deps</span>
                        <Badge variant={status.variant}>
                          {status.icon}
                          {status.label}
                        </Badge>
                      </div>
                    </div>
                    {depCount > 0 && missing > 0 && (
                      <Button
                        onClick={() => fixDeps(r.plugin)}
                        disabled={op?.busy}
                        className="shrink-0"
                      >
                        {op?.busy ? (
                          <Spinner size="sm" />
                        ) : (
                          <Wrench className="w-3.5 h-3.5" />
                        )}
                        Fix deps
                      </Button>
                    )}
                  </div>
                  {op?.error && (
                    <p className="mt-1 ml-6 text-[11px] text-destructive font-mono break-all">{op.error}</p>
                  )}
                  {op?.success && (
                    <p className="mt-1 ml-6 text-[11px] text-success">Dependencies installed.</p>
                  )}
                  {open && depCount > 0 && (
                    <div className="mt-1.5 ml-6 rounded-md bg-muted border px-2 py-1.5">
                      <ul className="space-y-0.5">
                        {r.dependencies.map((d) => (
                          <li
                            key={d.name}
                            className="flex items-center justify-between text-[11px] font-mono"
                          >
                            <span className="text-foreground truncate">
                              {d.name}
                              {d.version && <span className="text-muted-foreground">{d.version}</span>}
                            </span>
                            {d.missing ? (
                              <span className="text-destructive">missing</span>
                            ) : d.versionMismatch ? (
                              <span className="text-warning">version mismatch</span>
                            ) : (
                              <span className="text-success">ok</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
