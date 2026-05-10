// Context-settings popover content (strategy / temperature / format / soul +
// inline Compact-now). Pure body — caller wraps in <Popover><PopoverContent>.
// Replaces the editing half of the old ContextMeter; the read-only meter info
// now lives in <ContextMeterSummary> at the aside footer.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SlidersHorizontal, Wand2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { Slider } from '../ui/slider';
import SoulPicker from './SoulPicker';
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
  onDraftOverrideChange: (patch: DraftOverrides) => void;
  soulName: string | null;
  onSoulNameChange: (next: string | null) => void;
  /** Optional callback fired after a Compact-now succeeds — lets the parent
   *  close the popover. */
  onAfterCompact?: () => void;
}

const STRATEGY_LABELS: Record<ChatContextStrategy, string> = {
  sliding: 'Sliding',
  auto: 'Auto',
};

const STRATEGY_DESCRIPTIONS: Record<ChatContextStrategy, string> = {
  sliding: 'At 80% budget, older turns are skipped on outgoing requests. History stays intact.',
  auto: 'At 80% budget, the conversation is summarized in place. Destructive: scrollback collapses.',
};

export default function ContextSettings({
  conversationId, model, initialUsage, usageVersion,
  draftOverrides, onDraftOverrideChange,
  soulName, onSoulNameChange,
  onAfterCompact,
}: Props) {
  const [serverUsage, setServerUsage] = useState<ChatUsageState | null>(null);
  const [compacting, setCompacting] = useState(false);
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

  const handleTemperatureChange = async (next: number | null) => {
    if (!conversationId) { onDraftOverrideChange({ temperature: next }); return; }
    try { await api.chat.setTemperature(conversationId, next); refresh(); }
    catch (err) {
      toast.error('Could not update temperature', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleFormatChange = async (next: 'json' | null) => {
    if (!conversationId) { onDraftOverrideChange({ format: next }); return; }
    try { await api.chat.setFormat(conversationId, next); refresh(); }
    catch (err) {
      toast.error('Could not update output format', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSoulNameChange = async (next: string | null) => {
    onSoulNameChange(next);
    if (!conversationId) return;
    try {
      await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soul_name: next }),
      });
    } catch (err) {
      toast.error('Could not update soul', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleStrategyChange = async (next: ChatContextStrategy) => {
    if (!conversationId) { onDraftOverrideChange({ contextStrategy: next }); return; }
    try {
      await api.chat.setStrategy(conversationId, next);
      setServerUsage(prev => prev ? { ...prev, strategy: next } : prev);
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
      chatEvents.dispatchDone({
        msgId: '',
        stats: {
          tokens_in: null, tokens_out: null,
          ms_to_first_token: null, ms_total: null, tokens_per_sec: null,
          model: null, load_duration_ms: null,
        },
      });
      chatEvents.dispatchCompacted({ conversationId });
      onAfterCompact?.();
    } catch (err) {
      toast.error('Compact failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCompacting(false);
    }
  };

  return (
    <div className="scrollbar-subtle">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <SlidersHorizontal className="h-3 w-3" />
          Context settings
        </div>
        {conversationId && (
          <Button
            onClick={handleCompact}
            disabled={compacting}
            variant="destructive"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
          >
            {compacting ? <Spinner size="xs" /> : <Wand2 className="h-3 w-3" />}
            {compacting ? 'Compacting...' : 'Compact now'}
          </Button>
        )}
      </div>
      <div className="space-y-1.5 p-3">
        {(['sliding', 'auto'] as ChatContextStrategy[]).map(s => {
          const active = usage.strategy === s;
          return (
            <label
              key={s}
              className={`block cursor-pointer rounded-md p-3 transition-colors ${
                active ? 'bg-brand/10 ring-1 ring-inset ring-brand/40' : 'hover:bg-muted'
              }`}
            >
              <input
                type="radio"
                name="context-strategy"
                className="sr-only"
                checked={active}
                onChange={() => handleStrategyChange(s)}
              />
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 ${
                    active ? 'border-brand' : 'border-muted-foreground/40'
                  }`}
                >
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                </span>
                <span className={`text-xs font-medium ${active ? 'text-brand' : 'text-foreground'}`}>
                  {STRATEGY_LABELS[s]}
                </span>
              </div>
              <div className="ml-6 mt-1.5 text-xs leading-snug text-muted-foreground">
                {STRATEGY_DESCRIPTIONS[s]}
              </div>
            </label>
          );
        })}
      </div>
      {/* Temperature slider */}
      {(() => {
        const STEP = 0.05;
        const MAX = 1.5;
        const STEPS = Math.round(MAX / STEP);
        const indexFromValue = (v: number | null): number => {
          if (v === null) return 0;
          return Math.max(1, Math.min(STEPS + 1, Math.round(v / STEP) + 1));
        };
        const valueFromIndex = (i: number): number | null =>
          i === 0 ? null : Math.round((i - 1) * STEP * 100) / 100;
        const display = usage.temperature === null ? 'Auto' : usage.temperature.toFixed(2);
        return (
          <div className="context-meter-section">
            <div className="context-meter-section-head">
              <div className="text-xs font-semibold text-foreground">Temperature</div>
              <span className="font-mono text-xs text-foreground">{display}</span>
            </div>
            <div className="mt-3 px-1">
              <Slider
                min={0}
                max={STEPS + 1}
                step={1}
                value={[indexFromValue(usage.temperature)]}
                onValueChange={(vs) => handleTemperatureChange(valueFromIndex(vs[0] ?? 0))}
              />
              <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                <span>Auto</span>
                <span>0.0</span>
                <span>0.7</span>
                <span>1.5</span>
              </div>
            </div>
          </div>
        );
      })()}
      {/* Output format pills */}
      {(() => {
        const isJson = usage.format === 'json';
        return (
          <div className="context-meter-section">
            <div className="context-meter-section-head">
              <div className="text-xs font-semibold text-foreground">Output format</div>
              <span className="font-mono text-xs text-foreground">{isJson ? 'json' : 'text'}</span>
            </div>
            <div className="mt-2 inline-flex w-full overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => handleFormatChange(null)}
                className={`context-meter-pill ${!isJson ? 'is-active' : ''}`}
              >
                Text
              </button>
              <button
                type="button"
                onClick={() => handleFormatChange('json')}
                className={`context-meter-pill ${isJson ? 'is-active' : ''}`}
              >
                JSON
              </button>
            </div>
          </div>
        );
      })()}
      {/* Soul */}
      <div className="context-meter-section">
        <div className="context-meter-section-head">
          <div className="text-xs font-semibold text-foreground">Soul</div>
        </div>
        <div className="mt-2">
          <SoulPicker
            value={soulName}
            onChange={handleSoulNameChange}
            variant="compact"
          />
        </div>
      </div>
    </div>
  );
}
