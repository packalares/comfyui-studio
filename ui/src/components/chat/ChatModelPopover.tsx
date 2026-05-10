// Composer-bottom popover that bundles three controls into one panel:
//   1. Thinking on/off row
//   2. Context-window slider
//   3. Installed-models list with capability badges
// Sits on the LEFT of the composer footer next to attach/image/web/tool icons.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, Brain, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { Slider } from '../ui/slider';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { useApp } from '../../context/AppContext';
import { chatEvents } from '../../services/chatEvents';
import {
  api, type ChatUsageState, type OllamaInstalledModel,
} from '../../services/comfyui';
import { modelIsVisionCapable } from './attachments';
import type { DraftOverrides } from '../../pages/Chat';

interface Props {
  installed: OllamaInstalledModel[];
  loading?: boolean;
  model: string;
  disabled?: boolean;
  libraryCapabilities?: Record<string, string[]>;
  onChange: (next: string) => void;
  // Writes to per-conversation server endpoints, or to draftOverrides pre-chat.
  conversationId: string | null;
  initialUsage: ChatUsageState | null;
  usageVersion: number;
  draftOverrides: DraftOverrides;
  onDraftOverrideChange: (patch: DraftOverrides) => void;
}

const KNOWN_CAPS = ['vision', 'tools', 'thinking', 'embedding'] as const;
type KnownCap = (typeof KNOWN_CAPS)[number];

interface DerivedRow {
  name: string;
  size?: number;
  caps: KnownCap[];
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${Math.round(mb)} MB`;
}

function formatCtxShort(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function buildCtxSteps(maxCtx: number): number[] {
  if (!Number.isFinite(maxCtx) || maxCtx <= 0) return [];
  if (maxCtx < 2048) return [maxCtx];
  const out: number[] = [];
  for (let v = 2048; v <= maxCtx; v *= 2) out.push(v);
  if (out[out.length - 1] !== maxCtx) out.push(maxCtx);
  return out;
}

function capsForModel(
  name: string,
  libraryCaps?: Record<string, string[]>,
): KnownCap[] {
  const baseName = name.split(':')[0];
  const fromLib = libraryCaps?.[baseName] ?? null;
  const set = new Set<KnownCap>();
  if (fromLib) {
    for (const c of fromLib) {
      if ((KNOWN_CAPS as readonly string[]).includes(c)) {
        set.add(c as KnownCap);
      }
    }
  }
  if (!set.has('vision') && modelIsVisionCapable(name, fromLib)) {
    set.add('vision');
  }
  if (/-thinking|qwq|deepseek-r1/i.test(name)) set.add('thinking');
  if (/embed/i.test(name)) set.add('embedding');
  return [...set];
}

function CapBadge({ cap }: { cap: KnownCap }) {
  const variant = cap === 'vision' ? 'brand' : 'secondary';
  return <Badge variant={variant} className="text-[10px]">{cap}</Badge>;
}

export default function ChatModelPopover({
  installed, loading, model, disabled, libraryCapabilities, onChange,
  conversationId, initialUsage, usageVersion,
  draftOverrides, onDraftOverrideChange,
}: Props) {
  const [open, setOpen] = useState(false);
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

  // Synthesize a usage view when no conversation exists yet so the controls
  // work pre-chat — writes go to draftOverrides and fold into chat.start on
  // the first send.
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

  const handleNumCtxChange = async (next: number | null) => {
    if (!conversationId) { onDraftOverrideChange({ numCtx: next }); return; }
    try { await api.chat.setNumCtx(conversationId, next); refresh(); }
    catch (err) {
      toast.error('Could not update context window', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleThinkModeChange = async (next: 'on' | 'off' | null) => {
    if (!conversationId) { onDraftOverrideChange({ thinkMode: next }); return; }
    try { await api.chat.setThinkMode(conversationId, next); refresh(); }
    catch (err) {
      toast.error('Could not update thinking mode', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const rows = useMemo<DerivedRow[]>(
    () => installed.map((m) => ({
      name: m.name, size: m.size, caps: capsForModel(m.name, libraryCapabilities),
    })),
    [installed, libraryCapabilities],
  );

  const noModel = !model;
  const noInstalled = installed.length === 0;

  const triggerLabel = loading
    ? null
    : noInstalled ? 'No models installed'
      : noModel ? 'Pick a model'
        : model;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          aria-label="Pick a chat model"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium bg-muted text-foreground hover:bg-secondary cursor-pointer transition-colors',
            !loading && noModel && 'text-destructive bg-destructive/10 hover:bg-destructive/20',
            (disabled || loading) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {loading ? (
            <span aria-label="Loading models" className="relative inline-block h-3.5 w-28 overflow-hidden rounded bg-muted">
              <span className="skeleton-shimmer" />
            </span>
          ) : (
            <>
              <Boxes className="h-3.5 w-3.5" />
              <span className="truncate max-w-[180px]">{triggerLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        // Override the default `max-h-96` — Thinking + Context window +
        // Models list (260px max) total ~440px, so the default cap clips
        // the last few rows of the internal scroll container.
        className="w-[360px] p-0 max-h-[480px]"
      >
        {/* Thinking — full-width clickable row, same pattern the old tools
            popover used for generate_image / web_search. Icon + label +
            description + on/off dot on the right; whole row toggles. */}
        {usage && (() => {
          const on = usage.thinkMode === 'on';
          return (
            <div className="border-b p-2">
              <button
                type="button"
                onClick={() => handleThinkModeChange(on ? 'off' : 'on')}
                aria-pressed={on}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left cursor-pointer transition-colors',
                  on ? 'bg-brand/10 hover:bg-brand/20' : 'hover:bg-muted',
                )}
              >
                <Brain className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-brand' : 'text-muted-foreground')} />
                <div className="flex-1 min-w-0">
                  <div className={cn('text-xs font-medium', on ? 'text-brand' : 'text-foreground')}>
                    Thinking
                  </div>
                  <div className="text-[11px] leading-snug text-muted-foreground">
                    Force the model to emit reasoning before its reply.
                  </div>
                </div>
                <span
                  aria-hidden
                  className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', on ? 'bg-brand' : 'bg-muted-foreground')}
                />
              </button>
            </div>
          );
        })()}
        {/* Context window slider */}
        {usage && (() => {
          const allowed = buildCtxSteps(usage.modelMaxCtx ?? 131072);
          const indexFromValue = (v: number | null) => {
            if (v === null) return 0;
            const i = allowed.indexOf(v);
            return i === -1 ? 0 : i + 1;
          };
          const valueFromIndex = (i: number): number | null =>
            i === 0 ? null : allowed[i - 1];
          const currentIndex = indexFromValue(usage.numCtx);
          const display = usage.numCtx === null ? 'Auto' : formatCtxShort(usage.numCtx);
          return (
            <div className="border-b px-3 py-2.5">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-foreground">Context window</div>
                <span className="font-mono text-[10px] text-foreground">{display}</span>
              </div>
              <Slider
                min={0}
                max={allowed.length}
                step={1}
                value={[currentIndex]}
                onValueChange={(vs) => handleNumCtxChange(valueFromIndex(vs[0] ?? 0))}
              />
              <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                <span>Auto</span>
                <span>{allowed.length > 0 ? formatCtxShort(allowed[allowed.length - 1]) : '—'}</span>
              </div>
            </div>
          );
        })()}
        {/* Models list */}
        <div className="px-3 py-2.5">
          <div className="text-xs font-semibold text-foreground mb-2">Models</div>
          <ul className="max-h-[260px] overflow-y-auto -mx-1 flex flex-col gap-0.5">
            {rows.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                {noInstalled ? 'No Ollama models installed.' : 'No models.'}
              </li>
            )}
            {rows.map((row) => {
              const selected = row.name === model;
              return (
                <li key={row.name}>
                  <button
                    type="button"
                    onClick={() => { onChange(row.name); setOpen(false); }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left cursor-pointer transition-colors',
                      selected ? 'bg-brand/10' : 'hover:bg-muted',
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center pt-0.5">
                      {selected && <Check className="h-3.5 w-3.5 text-success" />}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs">{row.name}</span>
                        {row.size !== undefined && (
                          <span className="text-[10px] text-muted-foreground">{formatSize(row.size)}</span>
                        )}
                      </div>
                      {row.caps.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {row.caps.map(c => <CapBadge key={c} cap={c} />)}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
