// Preset-choice chip row.
//
// Pikaso-style presets carry `{[default option]|other|another}` tokens
// inline in the prompt text. We RESOLVE those tokens immediately into the
// real prompt (default values substituted) so the textarea behaves like
// any other prompt — fully editable, no special syntax visible.
//
// This component renders a small row of chips BELOW the textarea, one per
// original token. Click a chip → popover with the option list + a Custom
// text input. Picking a value swaps it into the prompt by literal string
// replace at the current value's location.
//
// Exports:
//   - extractChoices(template):   parse the `{…|…}` tokens out of a raw
//                                 template string. Used by the caller to
//                                 decide whether to seed choice state +
//                                 to compute the resolved prompt.
//   - defaultChoiceValues(...):   per-token default value array (the
//                                 `[bracketed]` option, or the first).
//   - resolveTemplate(...):       substitute defaults to build the
//                                 initial prompt the user types in.
//   - <PromptChoices/>:           the chip row component itself.

import { ChevronDown, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Input } from '../ui/input';

const TOKEN_RE = /\{([^{}]+?\|[^{}]+?)\}/g;

export interface ChoiceToken {
  /** Position in the template where the token began (`{`). */
  index: number;
  /** Length of the raw token in the template, including braces. */
  length: number;
  /** All options, in declaration order, with `[brackets]` stripped. */
  options: string[];
  /** Index of the option marked `[default]`. -1 when no marker was set. */
  defaultIdx: number;
}

export function extractChoices(template: string): ChoiceToken[] {
  const out: ChoiceToken[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(template)) !== null) {
    const parts = m[1].split('|').map((p) => p.trim());
    let defaultIdx = -1;
    const options = parts.map((p, i) => {
      if (p.startsWith('[') && p.endsWith(']')) {
        defaultIdx = i;
        return p.slice(1, -1);
      }
      return p;
    });
    out.push({ index: m.index, length: m[0].length, options, defaultIdx });
  }
  return out;
}

export function defaultChoiceValues(template: string): string[] {
  return extractChoices(template).map((t) =>
    t.defaultIdx >= 0 ? t.options[t.defaultIdx] : t.options[0] ?? '',
  );
}

/** Substitute the `[bracketed]` default of each `{…|[opt]|…}` token into
 *  the template. Optional `choiceValues` overrides the per-token pick. */
export function resolveTemplate(template: string, choiceValues?: string[]): string {
  const tokens = extractChoices(template);
  if (tokens.length === 0) return template;
  let out = '';
  let cursor = 0;
  tokens.forEach((tok, i) => {
    out += template.slice(cursor, tok.index);
    const override = choiceValues?.[i];
    const pick = override ?? (tok.defaultIdx >= 0 ? tok.options[tok.defaultIdx] : tok.options[0]);
    out += pick ?? '';
    cursor = tok.index + tok.length;
  });
  out += template.slice(cursor);
  return out;
}

interface PromptChoicesProps {
  /** Option lists, one per chip. Length stays fixed for the lifetime of
   *  the active preset. */
  tokens: ChoiceToken[];
  /** Current pick per chip. Length === tokens.length. */
  values: string[];
  /** Called when the user picks (or types Custom). The handler swaps the
   *  prior value's first occurrence in the prompt with the new value. */
  onPick: (tokenIndex: number, next: string) => void;
}

/** Horizontal row of chips. Each chip's label is its current value; click
 *  opens a Popover with the option list plus a Custom… field. */
export function PromptChoices({ tokens, values, onPick }: PromptChoicesProps) {
  if (tokens.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tokens.map((tok, i) => (
        <ChoiceChip
          key={i}
          options={tok.options}
          value={values[i] ?? ''}
          onSelect={(v) => onPick(i, v)}
        />
      ))}
    </div>
  );
}

interface ChoiceChipProps {
  options: string[];
  value: string;
  onSelect: (next: string) => void;
}

function ChoiceChip({ options, value, onSelect }: ChoiceChipProps) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const isCustom = value && !options.includes(value);

  const commitCustom = () => {
    const trimmed = customDraft.trim();
    if (trimmed.length === 0) return;
    onSelect(trimmed);
    setCustomDraft('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={[
          'inline-flex items-center gap-1 rounded-md px-2 py-0.5',
          'border border-brand/30 bg-brand/10 text-foreground',
          'hover:bg-brand/15 hover:border-brand/50 transition-colors',
          'cursor-pointer font-medium text-[12px] leading-tight',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        ].join(' ')}
        aria-label={`Choose: ${value}`}
      >
        {isCustom ? <Sparkles className="h-3 w-3 text-brand" /> : null}
        <span className="max-w-[22ch] truncate">{value || '…'}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-1" align="start">
        <div className="flex flex-col gap-0.5 max-h-[300px] overflow-y-auto">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                onSelect(opt);
                setOpen(false);
              }}
              className={[
                'text-left text-xs px-2 py-1.5 rounded transition-colors',
                opt === value
                  ? 'bg-brand/15 text-brand font-semibold'
                  : 'hover:bg-muted text-foreground',
              ].join(' ')}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="mt-1 border-t pt-2 flex items-center gap-1">
          <Input
            value={customDraft}
            placeholder="Custom…"
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitCustom();
              }
            }}
            className="h-7 text-xs"
          />
          <button
            type="button"
            onClick={commitCustom}
            disabled={customDraft.trim().length === 0}
            className={[
              'h-7 rounded-md px-2 text-xs font-medium',
              'bg-brand text-brand-foreground hover:bg-brand/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            Use
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default PromptChoices;
