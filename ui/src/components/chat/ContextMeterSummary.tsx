// Always-visible context meter summary. Lives at the bottom of the chat aside
// in place of the old hover-triggered pill. Read-only — the editable controls
// (strategy / temperature / format / soul) live in ContextSettings, opened
// from the Settings tab in the aside header.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Database } from 'lucide-react';
import { ProgressCircle } from '../ui/progress-circle';
import { chatEvents } from '../../services/chatEvents';
import {
  api, type ChatContextStrategy, type ChatUsageState,
} from '../../services/comfyui';
import { useApp } from '../../context/AppContext';
import type { DraftOverrides } from '../../pages/Chat';

interface Props {
  conversationId: string | null;
  model: string;
  initialUsage: ChatUsageState | null;
  usageVersion: number;
  draftOverrides: DraftOverrides;
}

const STRATEGY_LABELS: Record<ChatContextStrategy, string> = {
  sliding: 'Sliding',
  auto: 'Auto',
};

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function fillStrokeFor(warning: ChatUsageState['warning'] | undefined): string {
  if (warning === 'red') return 'stroke-destructive';
  if (warning === 'yellow') return 'stroke-warning';
  return 'stroke-success';
}

export default function ContextMeterSummary({
  conversationId, model, initialUsage, usageVersion, draftOverrides,
}: Props) {
  const [serverUsage, setServerUsage] = useState<ChatUsageState | null>(null);
  const { chat: chatDefaults } = useApp();

  useEffect(() => { setServerUsage(initialUsage); }, [conversationId, initialUsage]);

  const refresh = useCallback(() => {
    if (!conversationId || !model) { setServerUsage(null); return; }
    api.chat.getUsage(conversationId, model)
      .then(setServerUsage)
      .catch(() => { /* transient */ });
  }, [conversationId, model]);

  useEffect(() => {
    if (usageVersion === 0) return;
    refresh();
  }, [usageVersion, refresh]);

  useEffect(() => {
    if (!conversationId) return;
    return chatEvents.onDone((p) => {
      if (p.usage) setServerUsage(p.usage);
      else refresh();
    });
  }, [conversationId, refresh]);

  const draftUsage: ChatUsageState | null = useMemo(() => {
    if (!model) return null;
    const defaultThink = chatDefaults?.defaultThinkMode ?? 'auto';
    return {
      used: 0, budget: null, percent: 0, estimatedNext: 0, warning: 'green',
      strategy: draftOverrides.contextStrategy
        ?? chatDefaults?.defaultContextStrategy ?? 'sliding',
      model, modelMaxCtx: null,
      numCtx: draftOverrides.numCtx ?? null,
      thinkMode: draftOverrides.thinkMode
        ?? (defaultThink === 'auto' ? null : defaultThink),
      temperature: draftOverrides.temperature ?? null,
      format: draftOverrides.format ?? null,
    };
  }, [model, draftOverrides, chatDefaults]);

  const usage = conversationId ? serverUsage : draftUsage;
  if (!usage) return null;

  const budgetKnown = usage.budget !== null;
  const pct = budgetKnown ? Math.round(usage.percent * 10) / 10 : 0;
  const fillStroke = fillStrokeFor(budgetKnown ? usage.warning : undefined);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Database className="h-3 w-3" />
          Context
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-medium text-foreground">
            {budgetKnown ? `${pct}%` : 'Auto'}
          </span>
          <ProgressCircle percent={pct} fillClassName={fillStroke} />
        </div>
      </div>
      <div className="space-y-1">
        <div className="kv-row">
          <span className="text-muted-foreground">Used</span>
          <span className="font-medium text-foreground">{formatTokens(usage.used)}</span>
        </div>
        <div className="kv-row">
          <span className="text-muted-foreground">Budget</span>
          <span className="font-medium text-foreground">
            {usage.budget !== null ? formatTokens(usage.budget) : 'Auto'}
          </span>
        </div>
        <div className="kv-row">
          <span className="text-muted-foreground">Strategy</span>
          <span className="font-medium text-foreground">{STRATEGY_LABELS[usage.strategy]}</span>
        </div>
      </div>
      {usage.warning === 'red' && (
        <div className="alert-rose text-[11px]">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Budget nearly full — the active strategy will trim older messages.</span>
        </div>
      )}
    </div>
  );
}
