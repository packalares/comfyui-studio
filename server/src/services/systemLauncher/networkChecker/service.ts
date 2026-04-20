// Network checker orchestrator.
//
// Flow:
//   triggerCheck() -> returns `{ checkId, status }` immediately.
//     Kicks off `runCheck()` in the background; caller polls
//     `getLog(checkId)` to see status/result.
//
// Concurrency: a single in-flight check is enough. If triggerCheck() is
// called while a check is still running, we start a second one anyway
// (independent id); each probes via its own curl subprocess and does not
// interfere with the other. `liveSettings` is a snapshot-at-call so a
// mid-check configurator update only affects the next trigger.

import { randomUUID } from 'crypto';
import { buildTargets, type ServiceName, type ServiceTarget } from './endpoints.js';
import { probe, type ProbeResult } from './connectivity.js';
import * as logs from './logs.js';
import type { CheckLog } from './logs.js';

export interface CheckSummary {
  accessible: boolean;
  url: string;
  label: string;
  latencyMs?: number;
  error?: string;
}

export type NetworkStatus = Record<ServiceName, CheckSummary>;

let lastResult: NetworkStatus | null = null;

export interface TriggerResponse {
  checkId: string;
  status: 'in_progress';
}

/**
 * Start a new network check. Returns the check id immediately; the caller
 * polls `getLog(checkId)` for progress.
 */
export function triggerCheck(): TriggerResponse {
  const checkId = randomUUID();
  logs.createLog(checkId);
  logs.appendEntry(checkId, 'Network check started', 'info');
  const targets = buildTargets();
  logs.appendEntry(checkId, `Probing ${targets.length} services`, 'info');
  void runCheck(checkId, targets).catch((err) => {
    logs.failLog(checkId, err instanceof Error ? err.message : String(err));
  });
  return { checkId, status: 'in_progress' };
}

async function runCheck(checkId: string, targets: ServiceTarget[]): Promise<void> {
  const entries = await Promise.all(
    targets.map(async (t) => {
      logs.appendEntry(checkId, `Probing ${t.url}`, 'info', t.name);
      const r = await probe(t.url, 'HEAD');
      logEntry(checkId, t, r);
      return [t.name, toSummary(t, r)] as const;
    }),
  );
  const result = Object.fromEntries(entries) as NetworkStatus;
  lastResult = result;
  logs.completeLog(
    checkId,
    Object.fromEntries(
      entries.map(([k, v]) => [k, { accessible: v.accessible, url: v.url, latencyMs: v.latencyMs }]),
    ) as CheckLog['result'],
  );
  logs.appendEntry(checkId, 'Network check completed', 'success');
}

function logEntry(id: string, t: ServiceTarget, r: ProbeResult): void {
  if (r.accessible) {
    logs.appendEntry(id, `OK ${t.label} status=${r.status ?? '?'} (${r.latencyMs ?? '?'}ms)`, 'success', t.name);
  } else if (r.error) {
    logs.appendEntry(id, `FAIL ${t.label}: ${r.error}`, 'error', t.name);
  } else {
    logs.appendEntry(id, `FAIL ${t.label} status=${r.status ?? '?'}`, 'error', t.name);
  }
}

function toSummary(t: ServiceTarget, r: ProbeResult): CheckSummary {
  return {
    accessible: r.accessible,
    url: t.url,
    label: t.label,
    latencyMs: r.latencyMs,
    error: r.error,
  };
}

// ---- Public accessors for routes ----

export function getLastResult(): NetworkStatus | null {
  return lastResult;
}

export function getLog(checkId: string): CheckLog | null {
  return logs.getLog(checkId);
}

/** Test-only: reset state between runs. */
export function __resetForTests(): void {
  lastResult = null;
  logs.__resetForTests();
}
