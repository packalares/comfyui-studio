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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Wand2, Database, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import SoulPicker from './SoulPicker';
import {
  HoverCard, HoverCardContent, HoverCardTrigger,
} from '../ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { Slider } from '../ui/slider';
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
  /** Pre-chat overrides — when no conversation exists, the popover writes
   *  here instead of calling the per-conv API endpoints. Folded into
   *  `api.chat.start` on first send (see Chat.tsx + StudioTransport). */
  draftOverrides: DraftOverrides;
  onDraftOverrideChange: (patch: DraftOverrides) => void;
  /** Active soul selection. null = server default. Shared with the composer
   *  so the picker in the pre-chat popover and the mid-chat popover stay
   *  in sync via Chat.tsx state. */
  soulName: string | null;
  onSoulNameChange: (next: string | null) => void;
}

const STRATEGY_LABELS: Record<ChatContextStrategy, string> = {
  sliding: 'Sliding',
  auto: 'Auto',
};

const STRATEGY_DESCRIPTIONS: Record<ChatContextStrategy, string> = {
  sliding: 'At 80% budget, older turns are skipped on outgoing requests. History stays intact.',
  auto: 'At 80% budget, the conversation is summarized in place. Destructive: scrollback collapses.',
};

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** Compact label for context-window pickers. 16384 → "16K". */
function formatCtxShort(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

// Common num_ctx steps the slider snaps to. Filtered to those <= the
// model's published max at render time so the upper end of the slider
// reflects what the active model can actually allocate.
// Build the slider's discrete steps from 2K up to the model's published max
// — powers of 2, with the actual max appended when it's not itself a power
// of 2 (so a 200K model gets … 64K, 128K, 200K). Falls back to a 128K
// ceiling when modelMaxCtx is unknown (model not loaded yet).
function buildCtxSteps(maxCtx: number): number[] {
  if (!Number.isFinite(maxCtx) || maxCtx <= 0) return [];
  if (maxCtx < 2048) return [maxCtx];
  const out: number[] = [];
  for (let v = 2048; v <= maxCtx; v *= 2) out.push(v);
  if (out[out.length - 1] !== maxCtx) out.push(maxCtx);
  return out;
}

function fillStrokeFor(warning: ChatUsageState['warning'] | undefined): string {
  if (warning === 'red') return 'stroke-destructive';
  if (warning === 'yellow') return 'stroke-warning';
  return 'stroke-success';
}

function textColorFor(warning: ChatUsageState['warning'] | undefined): string {
  if (warning === 'red') return 'text-destructive';
  if (warning === 'yellow') return 'text-warning';
  if (!warning) return 'text-muted-foreground';
  return 'text-success';
}

export default function ContextMeter({
  conversationId, model, draftOverrides, onDraftOverrideChange,
  soulName, onSoulNameChange,
}: Props) {
  const [serverUsage, setServerUsage] = useState<ChatUsageState | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { chat: chatDefaults } = useApp();

  const refresh = useCallback(() => {
    if (!conversationId || !model) {
      setServerUsage(null);
      return;
    }
    api.chat.getUsage(conversationId, model)
      .then(setServerUsage)
      .catch(() => { /* upstream may be transiently unreachable; meter hides */ });
  }, [conversationId, model]);

  // When no conversation exists yet, synthesize a usage-shaped object from
  // the popover drafts + global chat defaults. The user can then preview /
  // configure strategy + sliders before sending the first message; choices
  // are folded into `api.chat.start` (see StudioTransport) and persist as
  // the new conversation's initial overrides. Stats fields (used / budget /
  // estimatedNext) are zeroed because there's no conversation to measure.
  const draftUsage: ChatUsageState | null = useMemo(() => {
    if (!model) return null;
    const defaultThink = chatDefaults?.defaultThinkMode ?? 'auto';
    return {
      used: 0,
      budget: null,
      percent: 0,
      estimatedNext: 0,
      warning: 'green',
      strategy: draftOverrides.contextStrategy
        ?? chatDefaults?.defaultContextStrategy
        ?? 'sliding',
      model,
      modelMaxCtx: null,
      numCtx: draftOverrides.numCtx ?? null,
      thinkMode: draftOverrides.thinkMode
        ?? (defaultThink === 'auto' ? null : defaultThink),
      temperature: draftOverrides.temperature ?? null,
      format: draftOverrides.format ?? null,
    };
  }, [model, draftOverrides, chatDefaults]);

  // `usage` is the unified view — server-fetched for existing convs,
  // synthesized from drafts otherwise. Existing JSX reads from this var
  // unchanged.
  const usage = conversationId ? serverUsage : draftUsage;

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!conversationId) return;
    return chatEvents.onDone(() => { refresh(); });
  }, [conversationId, refresh]);

  // Always render — when no conversation / model / usage data we show 0%
  // (empty circle, slate text). Keeps the topbar layout stable so the search
  // input + tabs don't shift when a conversation is selected. With the
  // drafts-mode synthesis above, `usage` is non-null whenever a model is
  // selected, so the popover stays openable for pre-chat configuration.
  const hasData = !!usage;
  // `budget === null` means the user is on Auto AND the model isn't
  // loaded yet — we don't know the budget, so we can't compute a real
  // percentage. The pill switches to a literal "Auto" label and the
  // progress arc stays empty until the next request lands and /api/ps
  // returns the actual `context_length`.
  const budgetKnown = hasData && usage.budget !== null;
  const pct = budgetKnown ? Math.round(usage.percent * 10) / 10 : 0;
  const fillStroke = fillStrokeFor(budgetKnown ? usage.warning : undefined);
  const textColor = textColorFor(budgetKnown ? usage.warning : undefined);

  // Per-conversation num_ctx override. The slider snaps over the
  // {Auto, 2K, 4K, ..., model_max}-capped scale and writes the chosen
  // value via PATCH; on success we re-fetch usage so the meter reflects
  // the new budget immediately (otherwise the next chat:done would catch
  // up, which feels laggy for a tweak the user just made).
  const handleNumCtxChange = async (next: number | null) => {
    if (!conversationId) {
      onDraftOverrideChange({ numCtx: next });
      return;
    }
    try {
      await api.chat.setNumCtx(conversationId, next);
      refresh();
    } catch (err) {
      toast.error('Could not update context window', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Per-conversation temperature. NULL = Ollama default (~0.8). Slider
  // step is 0.05 over [0, 1.5] which covers virtually every chat use case
  // — temperatures above 1.5 reliably produce gibberish on most models.
  const handleTemperatureChange = async (next: number | null) => {
    if (!conversationId) {
      onDraftOverrideChange({ temperature: next });
      return;
    }
    try {
      await api.chat.setTemperature(conversationId, next);
      refresh();
    } catch (err) {
      toast.error('Could not update temperature', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Per-conversation output format. NULL = free text; 'json' tells Ollama
  // to constrain output to valid JSON via the top-level `format` field.
  const handleFormatChange = async (next: 'json' | null) => {
    if (!conversationId) {
      onDraftOverrideChange({ format: next });
      return;
    }
    try {
      await api.chat.setFormat(conversationId, next);
      refresh();
    } catch (err) {
      toast.error('Could not update output format', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Per-conversation soul override. Sent via PATCH /chat/conversations/:id
  // with { soul_name }. null = use the server-default soul. Changes take
  // effect on the next assistant turn (server re-resolves the system prompt).
  const handleSoulNameChange = async (next: string | null) => {
    // Always update the shared state immediately (optimistic).
    onSoulNameChange(next);
    if (!conversationId) return; // pre-chat: localStorage write happens in Chat.tsx
    try {
      await fetch(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ soul_name: next }),
        },
      );
    } catch (err) {
      toast.error('Could not update soul', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Per-conversation reasoning-mode override. The three-state pill maps
  // 'auto' → null (model default), 'on' → 'on' (force think:true), 'off'
  // → 'off' (force think:false, ~30x fewer tokens on thinking models).
  const handleThinkModeChange = async (next: 'on' | 'off' | null) => {
    if (!conversationId) {
      onDraftOverrideChange({ thinkMode: next });
      return;
    }
    try {
      await api.chat.setThinkMode(conversationId, next);
      refresh();
    } catch (err) {
      toast.error('Could not update thinking mode', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleStrategyChange = async (next: ChatContextStrategy) => {
    if (!conversationId) {
      onDraftOverrideChange({ contextStrategy: next });
      return;
    }
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
      // Two events: `chat:done` bumps the sidebar's updated_at (synthetic
      // stats); `chat:compacted` tells the page to re-hydrate the active
      // thread from the DB, since the compact rewrote `chat_messages`
      // (deleted everything, inserted a single system summary). Without
      // the second event the visible scrollback would stay stale until
      // the user switched conversations.
      chatEvents.dispatchDone({
        msgId: '',
        stats: {
          tokens_in: null, tokens_out: null,
          ms_to_first_token: null, ms_total: null, tokens_per_sec: null,
          model: null, load_duration_ms: null,
        },
      });
      chatEvents.dispatchCompacted({ conversationId });
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
              <span>{budgetKnown ? `${pct}%` : 'Auto'}</span>
              <ProgressCircle percent={pct} fillClassName={fillStroke} />
            </button>
          </PopoverTrigger>
        </HoverCardTrigger>
        {hasData && (
          <HoverCardContent className="w-72 p-3.5 leading-snug">
            <div className="-mx-3.5 -mt-3.5 mb-2.5 flex items-center gap-1.5 rounded-t-lg border-b bg-muted/40 px-3.5 py-3 text-xs font-semibold text-foreground">
              <Database className="h-3 w-3" />
              Context window
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="kv-row">
                <span className="text-muted-foreground">Budget</span>
                <span className="font-medium text-foreground">
                  {usage.budget !== null ? formatTokens(usage.budget) : 'Auto (load to detect)'}
                </span>
              </div>
              <div className="kv-row">
                <span className="text-muted-foreground">Used</span>
                <span className="font-medium text-foreground">{formatTokens(usage.used)}</span>
              </div>
              <div className="kv-row">
                <span className="text-muted-foreground">Estimated next</span>
                <span className="font-medium text-foreground">{formatTokens(usage.estimatedNext)}</span>
              </div>
              <div className="kv-row">
                <span className="text-muted-foreground">Strategy</span>
                <span className="font-medium text-foreground">{STRATEGY_LABELS[usage.strategy]}</span>
              </div>
            </div>
            {usage.warning === 'red' && (
              <div className="alert-rose mt-2.5 text-xs">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>Budget nearly full — the active strategy will trim older messages.</span>
              </div>
            )}
          </HoverCardContent>
        )}
      </HoverCard>
      {hasData && (
        <PopoverContent
          align="end"
          // `max-h-[80vh] overflow-y-auto` keeps the popover usable on
          // shorter viewports — the strategy + slider + compact stack adds
          // up to ~520px and previously pushed "Compact now" off-screen.
          className="scrollbar-subtle w-80 max-h-[80vh] overflow-y-auto p-0"
        >
          {/* Header strip — title + inline Compact-now action. Sticky so it
              stays anchored when the body (5 sections + slider) scrolls.
              Uses opaque `bg-muted` (not bg-muted/40) so scrolled content
              doesn't bleed through under the title. */}
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <SlidersHorizontal className="h-3 w-3" />
              Context strategy
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
          {/* Selectable cards — hide the native radio circle and let the
              row itself signal selection via teal ring + bg. The full row
              is the click target so the cursor/hover area matches the
              visible affordance instead of needing to land on the dot. */}
          <div className="space-y-1.5 p-3">
            {(['sliding', 'auto'] as ChatContextStrategy[]).map(s => {
              const active = usage.strategy === s;
              return (
                <label
                  key={s}
                  className={`block cursor-pointer rounded-md p-3 transition-colors ${
                    active
                      ? 'bg-brand/10 ring-1 ring-inset ring-brand/40'
                      : 'hover:bg-muted'
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
          {/* Context-window slider — discrete snap over Auto + powers of
              two up to the model's published max. "Auto" omits
              `options.num_ctx` from the request so Ollama uses its own
              default (typically 2048). Picking a value pins it and the
              send path mirrors it via `options.num_ctx` so the meter's
              budget matches what's actually allocated per request. */}
          {(() => {
            const allowed = buildCtxSteps(usage.modelMaxCtx ?? 131072);
            // Index 0 = "Auto" (null). Indices 1..allowed.length map to
            // allowed[i-1].
            const indexFromValue = (v: number | null) => {
              if (v === null) return 0;
              const i = allowed.indexOf(v);
              return i === -1 ? 0 : i + 1;
            };
            const valueFromIndex = (i: number): number | null =>
              i === 0 ? null : allowed[i - 1];
            const currentIndex = indexFromValue(usage.numCtx);
            const display = usage.numCtx === null
              ? 'Auto'
              : formatCtxShort(usage.numCtx);
            return (
              <div className="context-meter-section">
                <div className="context-meter-section-head">
                  <div className="text-xs font-semibold text-foreground">
                    Context window
                  </div>
                  <span className="font-mono text-xs text-foreground">{display}</span>
                </div>
                <div className="mt-3 px-1">
                  <Slider
                    min={0}
                    max={allowed.length}
                    step={1}
                    value={[currentIndex]}
                    onValueChange={(vs) => {
                      const i = vs[0] ?? 0;
                      handleNumCtxChange(valueFromIndex(i));
                    }}
                  />
                  <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                    <span>Auto</span>
                    <span>{allowed.length > 0 ? formatCtxShort(allowed[allowed.length - 1]) : '—'}</span>
                  </div>
                </div>
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {usage.numCtx === null && usage.budget !== null
                    && `Auto: Ollama allocated ${formatCtxShort(usage.budget)}. Pin to override.`}
                  {usage.numCtx === null && usage.budget === null
                    && 'Auto: send a message to detect the budget.'}
                  {usage.numCtx !== null
                    && `Pinned: requests use num_ctx=${usage.numCtx.toLocaleString()}.`}
                </p>
              </div>
            );
          })()}
          {/* Thinking-mode pills. `Auto` clears the override (model default
              wins); `On` / `Off` force `think: true|false` on every
              outgoing /api/chat call from this conversation. Off is the
              fast path on thinking-mode models (qwen3.5, gemma3) — those
              spend the bulk of eval tokens on the reasoning trace, so
              disabling drops latency to seconds-not-minutes. */}
          {(() => {
            const choices: Array<{ key: 'auto' | 'on' | 'off'; label: string; value: 'on' | 'off' | null }> = [
              { key: 'auto', label: 'Auto', value: null },
              { key: 'on', label: 'On', value: 'on' },
              { key: 'off', label: 'Off', value: 'off' },
            ];
            const currentKey = usage.thinkMode === 'on' ? 'on' : usage.thinkMode === 'off' ? 'off' : 'auto';
            return (
              <div className="context-meter-section">
                <div className="context-meter-section-head">
                  <div className="text-xs font-semibold text-foreground">
                    Thinking
                  </div>
                  <span className="font-mono text-xs text-foreground">{currentKey}</span>
                </div>
                <div className="mt-2 inline-flex w-full overflow-hidden rounded-md border">
                  {choices.map((c) => {
                    const active = currentKey === c.key;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => handleThinkModeChange(c.value)}
                        className={`context-meter-pill ${active ? 'is-active' : ''}`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {currentKey === 'auto' && 'Model decides whether to emit chain-of-thought.'}
                  {currentKey === 'on' && 'Forces the model to emit reasoning. Renders as the collapsible "Thinking" panel.'}
                  {currentKey === 'off' && 'Suppresses chain-of-thought. Much faster on thinking-mode models.'}
                </p>
              </div>
            );
          })()}
          {/* Temperature slider — 0.0 (deterministic) to 1.5 (very wild)
              with 0.05 steps. NULL = Ollama default (~0.8). The slider
              treats index 0 as "Auto" so the user has a discoverable way
              to clear the override without typing. */}
          {(() => {
            const STEP = 0.05;
            const MAX = 1.5;
            const STEPS = Math.round(MAX / STEP);  // 30 steps over [0, 1.5]
            // Index 0 = Auto (null). Indices 1..STEPS+1 map to 0.0..MAX.
            const indexFromValue = (v: number | null): number => {
              if (v === null) return 0;
              return Math.max(1, Math.min(STEPS + 1, Math.round(v / STEP) + 1));
            };
            const valueFromIndex = (i: number): number | null =>
              i === 0 ? null : Math.round((i - 1) * STEP * 100) / 100;
            const display = usage.temperature === null
              ? 'Auto'
              : usage.temperature.toFixed(2);
            return (
              <div className="context-meter-section">
                <div className="context-meter-section-head">
                  <div className="text-xs font-semibold text-foreground">
                    Temperature
                  </div>
                  <span className="font-mono text-xs text-foreground">{display}</span>
                </div>
                <div className="mt-3 px-1">
                  <Slider
                    min={0}
                    max={STEPS + 1}
                    step={1}
                    value={[indexFromValue(usage.temperature)]}
                    onValueChange={(vs) => {
                      handleTemperatureChange(valueFromIndex(vs[0] ?? 0));
                    }}
                  />
                  <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                    <span>Auto</span>
                    <span>0.0</span>
                    <span>0.7</span>
                    <span>1.5</span>
                  </div>
                </div>
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {usage.temperature === null
                    ? 'Auto: Ollama default (~0.8). Lower = more focused, higher = more creative.'
                    : `Pinned: every request from this chat sends options.temperature=${usage.temperature.toFixed(2)}.`}
                </p>
              </div>
            );
          })()}
          {/* Output format pills. JSON forces the model to emit valid JSON
              via Ollama's top-level `format: 'json'` field — useful for
              tool-light chats that consume structured replies. */}
          {(() => {
            const isJson = usage.format === 'json';
            return (
              <div className="context-meter-section">
                <div className="context-meter-section-head">
                  <div className="text-xs font-semibold text-foreground">
                    Output format
                  </div>
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
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {isJson
                    ? 'Replies are constrained to valid JSON. Tell the model what shape you want in your message.'
                    : 'Free-form text replies (default).'}
                </p>
              </div>
            );
          })()}
          {/* Soul (personality) picker — compact variant sits at the bottom
              of the popover so users can switch the active persona mid-chat.
              The change is applied on the next assistant turn; the server
              re-resolves the system prompt using the updated soul. */}
          <div className="context-meter-section">
            <div className="context-meter-section-head">
              <div className="text-xs font-semibold text-foreground">
                Soul
              </div>
            </div>
            <div className="mt-2">
              <SoulPicker
                value={soulName}
                onChange={handleSoulNameChange}
                variant="compact"
              />
            </div>
            <p className="mt-2 text-xs leading-snug text-muted-foreground">
              The active personality (system prompt) for this conversation.
              Changes take effect on the next message.
            </p>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
