import { Fragment, useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
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
import type { PluginsOutletContext } from '../../pages/Plugins';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { Spinner } from '../ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

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

  // Refresh button lives in the shared Plugins subbar; cleared on route change.
  const { setSubbarRight } = useOutletContext<PluginsOutletContext>();
  useEffect(() => {
    setSubbarRight(
      <Button
        onClick={load}
        variant="ghost"
        size="icon"
        aria-label="Refresh dependency report"
        disabled={loading}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
      </Button>,
    );
    return () => setSubbarRight(null);
  }, [setSubbarRight, load, loading]);

  // 4 columns: expand toggle | Plugin | Deps | Status | Actions
  const COL_COUNT = 5;

  return (
    <>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Expand</span>
              </TableHead>
              <TableHead>Plugin</TableHead>
              <TableHead className="text-right">Deps</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && reports.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-3.5 w-3.5" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-8 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : reports.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COL_COUNT}>
                  <div className="empty-box">No plugins installed.</div>
                </TableCell>
              </TableRow>
            ) : (
              reports.map((r) => {
                const missing = r.missingDeps.length;
                const depCount = r.dependencies.length;
                const op = ops[r.plugin];
                const open = expanded[r.plugin];
                const statusVariant = missing === 0 ? 'success' : 'warning';
                const statusLabel = missing === 0 ? 'OK' : `${missing} missing`;
                const statusIcon =
                  missing === 0 ? (
                    <CheckCircle2 className="w-3 h-3" />
                  ) : (
                    <AlertTriangle className="w-3 h-3" />
                  );

                return (
                  <Fragment key={r.plugin}>
                    <TableRow>
                      <TableCell className="w-8">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() =>
                                setExpanded((e) => ({ ...e, [r.plugin]: !e[r.plugin] }))
                              }
                              className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                              aria-label={open ? 'Collapse' : 'Expand'}
                              disabled={depCount === 0}
                            >
                              {open ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{open ? 'Collapse' : 'Expand requirements'}</TooltipContent>
                        </Tooltip>
                      </TableCell>

                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm font-medium text-foreground truncate block cursor-default">
                              {r.plugin}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="break-words">{r.plugin}</TooltipContent>
                        </Tooltip>
                      </TableCell>

                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                        {depCount}
                      </TableCell>

                      <TableCell>
                        <Badge variant={statusVariant}>
                          {statusIcon}
                          {statusLabel}
                        </Badge>
                      </TableCell>

                      <TableCell className="text-right">
                        {depCount > 0 && missing > 0 && (
                          <Button
                            onClick={() => fixDeps(r.plugin)}
                            disabled={op?.busy}
                            size="sm"
                          >
                            {op?.busy ? (
                              <Spinner size="sm" />
                            ) : (
                              <Wrench className="w-3.5 h-3.5" />
                            )}
                            Fix deps
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>

                    {/* Expanded detail row: dep list + op feedback */}
                    {(open || op?.error || op?.success) && (
                      <TableRow key={`${r.plugin}-detail`}>
                        <TableCell colSpan={COL_COUNT} className="py-1.5 bg-muted/30">
                          {op?.error && (
                            <p className="mb-1.5 text-[11px] text-destructive font-mono break-all">
                              {op.error}
                            </p>
                          )}
                          {op?.success && (
                            <p className="mb-1.5 text-[11px] text-success">
                              Dependencies installed.
                            </p>
                          )}
                          {open && depCount > 0 && (
                            <div className="rounded-md bg-muted border px-2 py-1.5">
                              <ul className="space-y-0.5">
                                {r.dependencies.map((d) => (
                                  <li
                                    key={d.name}
                                    className="flex items-center justify-between text-[11px] font-mono"
                                  >
                                    <span className="text-foreground truncate">
                                      {d.name}
                                      {d.version && (
                                        <span className="text-muted-foreground">{d.version}</span>
                                      )}
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
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
