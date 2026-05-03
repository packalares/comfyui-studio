// Phase F context-window meter. Renders a compact "12,450 / 128,000 tokens
// (10%)" pill in the chat header. Hover reveals the breakdown; click opens
// a popover with the strategy switcher + manual /compact button.
//
// Refresh strategy:
//   - on conversation switch (via useEffect on conversationId);
//   - after every chat:done envelope (subscribe via chatEvents).
// We don't fetch on every keystroke — pendingUserText is intentionally not
// wired into the polling path because the meter is a guidance tool, not a
// per-keystroke counter.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Wand2, Database, AlertTriangle } from 'lucide-react';
import {
  HoverCard, HoverCardContent, HoverCardTrigger,
} from '../ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { ProgressCircle } from '../ui/progress-circle';
import { chatEvents } from '../../services/chatEvents';
import {
  api, type ChatContextStrategy, type ChatUsageState,
} from '../../services/comfyui';

interface Props {
  conversationId: string | null;
  model: string;
}

const STRATEGY_LABELS: Record<ChatContextStrategy, string> = {
  sliding: 'Sliding window',
  summarize: 'Summarize',
  manual: 'Manual',
};

const STRATEGY_DESCRIPTIONS: Record<ChatContextStrategy, string> = {
  sliding: 'Drops the oldest user/assistant turns when the budget hits 80%, keeping the system prompt and recent context intact.',
  summarize: 'Replaces older turns with a one-shot model-generated summary the moment the budget hits 80%.',
  manual: 'Never trims automatically. You will see a warning when the budget is nearly full and can press "Compact now" to summarize on demand.',
};

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function fillStrokeFor(warning: ChatUsageState['warning'] | undefined): string {
  if (warning === 'red') return 'stroke-rose-500';
  if (warning === 'yellow') return 'stroke-amber-500';
  return 'stroke-emerald-500';
}

function textColorFor(warning: ChatUsageState['warning'] | undefined): string {
  if (warning === 'red') return 'text-rose-700';
  if (warning === 'yellow') return 'text-amber-700';
  if (!warning) return 'text-slate-500';
  return 'text-emerald-700';
}

export default function ContextMeter({ conversationId, model }: Props) {
  const [usage, setUsage] = useState<ChatUsageState | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = useCallback(() => {
    if (!conversationId || !model) {
      setUsage(null);
      return;
    }
    api.chat.getUsage(conversationId, model)
      .then(setUsage)
      .catch(() => { /* upstream may be transiently unreachable; meter hides */ });
  }, [conversationId, model]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!conversationId) return;
    return chatEvents.onDone(() => { refresh(); });
  }, [conversationId, refresh]);

  // Always render — when no conversation / model / usage data we show 0%
  // (empty circle, slate text). Keeps the topbar layout stable so the search
  // input + tabs don't shift when a conversation is selected.
  const hasData = !!(conversationId && model && usage);
  const pct = hasData ? Math.round(usage.percent * 10) / 10 : 0;
  const fillStroke = fillStrokeFor(hasData ? usage.warning : undefined);
  const textColor = textColorFor(hasData ? usage.warning : undefined);

  const handleStrategyChange = async (next: ChatContextStrategy) => {
    if (!conversationId) return;
    try {
      await api.chat.setStrategy(conversationId, next);
      setUsage(prev => prev ? { ...prev, strategy: next } : prev);
    } catch (err) {
      toast.error('Could not update strategy', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCompact = async () => {
    if (!conversationId || compacting) return;
    setCompacting(true);
    try {
      await api.chat.compactConversation(conversationId);
      toast.success('Conversation compacted');
      // Trigger a hard refetch via the chat:done bus the page already subscribes
      // to. We dispatch synthetic stats so the sidebar updates `updated_at`.
      chatEvents.dispatchDone({
        msgId: '',
        stats: {
          tokens_in: null, tokens_out: null,
          ms_to_first_token: null, ms_total: null, tokens_per_sec: null,
          model: null,
        },
      });
      setPickerOpen(false);
    } catch (err) {
      toast.error('Compact failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCompacting(false);
    }
  };

  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <HoverCard openDelay={200} closeDelay={120}>
        <HoverCardTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`context-meter-trigger ${textColor}`}
              aria-label="Context window usage"
              disabled={!hasData}
            >
              <span>{pct}%</span>
              <ProgressCircle percent={pct} fillClassName={fillStroke} />
            </button>
          </PopoverTrigger>
        </HoverCardTrigger>
        {hasData && (
          <HoverCardContent className="w-72 p-3 text-xs leading-snug">
            <div className="eyebrow flex items-center gap-1.5">
              <Database className="h-3 w-3" />
              Context window
            </div>
            <div className="mt-2 space-y-1 font-mono text-[11px] text-slate-700">
              <div className="kv-row"><span>Budget</span><span>{formatTokens(usage.budget)}</span></div>
              <div className="kv-row"><span>Used</span><span>{formatTokens(usage.used)}</span></div>
              <div className="kv-row"><span>Estimated next</span><span>{formatTokens(usage.estimatedNext)}</span></div>
              <div className="kv-row"><span>Strategy</span><span>{STRATEGY_LABELS[usage.strategy]}</span></div>
            </div>
            {usage.warning === 'red' && (
              <div className="alert-rose mt-2 text-[11px]">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>Budget nearly full. The active strategy will trim older messages on the next send.</span>
              </div>
            )}
          </HoverCardContent>
        )}
      </HoverCard>
      {hasData && (
        <PopoverContent align="end" className="w-80 p-3 text-xs">
          <div className="eyebrow">Context strategy</div>
          <div className="mt-2 space-y-1.5">
            {(['sliding', 'summarize', 'manual'] as ChatContextStrategy[]).map(s => (
              <label key={s} className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-slate-50">
                <input
                  type="radio"
                  name="context-strategy"
                  className="mt-0.5"
                  checked={usage.strategy === s}
                  onChange={() => handleStrategyChange(s)}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-800">{STRATEGY_LABELS[s]}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
                    {STRATEGY_DESCRIPTIONS[s]}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="mt-3 border-t border-slate-100 pt-3">
            <Button
              onClick={handleCompact}
              disabled={compacting}
              variant="secondary"
              size="sm"
              className="w-full"
            >
              {compacting ? <Spinner size="xs" /> : <Wand2 className="h-3 w-3" />}
              {compacting ? 'Compacting...' : 'Compact now'}
            </Button>
            <p className="mt-1 text-[10px] leading-tight text-slate-500">
              Replaces the entire transcript with a one-shot summary. Original messages are removed; the conversation row is preserved.
            </p>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
