// Editable prompt with INLINE choice chips, registry-driven `@name` chips,
// `@reference` mention highlighting, and an `@`-triggered mention picker.
//
// Drop-in replacement for the textarea + transparent-mirror-overlay pattern
// used by ImageBuilder/VideoBuilder before. Single contentEditable div is
// the source of truth: parsing `value` rebuilds the DOM, user input is
// re-read out of the DOM and shipped back via `onChange`.
//
// Token kinds and their behaviour are documented in `lib/promptTemplate.ts`.
// This file is purely the React + DOM glue.
//
// Why contentEditable: a `<textarea>` cannot host interactive widgets in
// its text flow, and we need clickable chips at token positions plus
// editable text between them. The DOM is managed imperatively (innerHTML
// + walkers) rather than as React children so the cursor stays put across
// keystrokes — React only re-renders the editable on EXTERNAL value
// changes (preset apply, parent reset, picker insert).
//
// Visual styling: see `.prompt-composer / .prompt-chip / .prompt-mention`
// in `index.css`. No design tokens or colors live in this file.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, AtSign } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { Button } from '../ui/button';
import {
  type PromptRegistry,
  type Segment,
  parseTemplate,
  segmentsToTemplate,
} from '../../lib/promptTemplate';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromptComposerMention {
  /** Exact string inserted into the prompt, e.g. `@reference1`. */
  key: string;
  /** Human-readable label rendered in the picker. */
  label: string;
  /** Category drives picker grouping / icon. `type` items come from the
   *  registry; `reference` from the builder. Modes are NOT surfaced — keep
   *  the `@` picker focused on user-actionable items only. */
  category?: 'reference' | 'type';
}

export interface PromptComposerProps {
  value: string;
  onChange: (next: string) => void;
  /** Reference mentions surfaced in the @-picker and highlighted inline.
   *  The composer pulls registry entries from `registry` directly — don't
   *  duplicate them here. */
  mentionables?: PromptComposerMention[];
  /** Registry of `@name → options[]` for chip rendering. */
  registry?: PromptRegistry;
  placeholder?: string;
  readOnly?: boolean;
  /** ARIA label for screen readers. */
  ariaLabel?: string;
}

// ---------------------------------------------------------------------------
// DOM rendering — converts a parsed segment list into HTML the
// contentEditable div hosts. Chips and mentions carry their state on data
// attributes so `readDom` can reconstruct the template without an external
// lookup table.
// ---------------------------------------------------------------------------

const CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"'
  + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"'
  + ' stroke-linecap="round" stroke-linejoin="round" style="opacity:0.55">'
  + '<polyline points="6 9 12 15 18 9"/></svg>';

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function segmentsToHTML(segments: Segment[]): string {
  let html = '';
  for (const s of segments) {
    if (s.kind === 'text') {
      html += escapeHTML(s.text);
      continue;
    }
    if (s.kind === 'mention') {
      html += `<span class="prompt-mention" data-mention="1"`
        + ` data-key="${escapeAttr(s.key)}" contenteditable="false">`
        + `${escapeHTML(s.key)}</span>`;
      continue;
    }
    // Chip — both inline and registry-named.
    html += `<button type="button" class="prompt-chip"`
      + ` data-chip="1" data-options='${escapeAttr(JSON.stringify(s.options))}'`
      + ` data-selected="${escapeAttr(s.selected)}"`
      + (s.tokenName ? ` data-token-name="${escapeAttr(s.tokenName)}"` : '')
      + ` contenteditable="false">`
      + `${escapeHTML(s.selected)}${CHEVRON_SVG}</button>`;
  }
  return html;
}

function readDomToSegments(el: HTMLElement): Segment[] {
  const segs: Segment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const tail = segs[segs.length - 1];
    if (tail && tail.kind === 'text') tail.text += text;
    else segs.push({ kind: 'text', text });
  };
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.chip === '1') {
      let options: string[] = [];
      try {
        const raw = node.dataset.options ?? '[]';
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) options = parsed.filter((s) => typeof s === 'string');
      } catch {
        options = [];
      }
      const selected = node.dataset.selected ?? '';
      const tokenName = node.dataset.tokenName;
      segs.push({ kind: 'chip', options, selected, tokenName });
      return;
    }
    if (node.dataset.mention === '1') {
      const key = node.dataset.key ?? node.textContent ?? '';
      if (key.startsWith('@')) segs.push({ kind: 'mention', key });
      return;
    }
    // Foreign element (browser-injected, pasted, etc.) — flatten its text.
    pushText(node.innerText ?? node.textContent ?? '');
  });
  return segs;
}

// ---------------------------------------------------------------------------
// `@`-picker — caret tracking inside the contentEditable.
// ---------------------------------------------------------------------------

interface PickerState {
  /** Viewport-px coords of the caret, used to position the picker. */
  rect: { x: number; y: number };
  filter: string;
  activeIndex: number;
}

/** Return the plain-text contents of the contentEditable from its start up
 *  to the current caret. Range.toString() walks the live DOM tree so chip
 *  widgets contribute their text content correctly — a TreeWalker that
 *  filters to TEXT nodes would skip the widget's text and report a stale
 *  offset relative to `el.innerText`. Returns null if no caret. */
function getTextBeforeCaret(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString();
}

/** Symmetric helper: plain-text from the caret to the end of the editable. */
function getTextAfterCaret(root: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return '';
  const after = document.createRange();
  after.setStart(range.startContainer, range.startOffset);
  after.setEnd(root, root.childNodes.length);
  return after.toString();
}

/** Viewport coords of the caret — bottom-left of the caret rect, used to
 *  anchor the @-picker right under where the user typed `@`. */
function getCaretRect(): { x: number; y: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return { x: rects[0].left, y: rects[0].bottom };
  // Empty ranges have no client rect in some browsers; materialise one
  // with a probe span, measure, then remove.
  const probe = document.createElement('span');
  probe.appendChild(document.createTextNode('​'));
  range.insertNode(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { x: r.left, y: r.bottom };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PromptComposer({
  value,
  onChange,
  mentionables = [],
  registry = {},
  placeholder,
  readOnly,
  ariaLabel,
}: PromptComposerProps) {
  const editableRef = useRef<HTMLDivElement>(null);
  /** Skip the next external-render pass after we just emitted onChange —
   *  the DOM already has the user's keystroke; replacing it trashes the
   *  cursor. Reset by the next external change (preset apply etc.). */
  const skipNextSync = useRef(false);
  /** Wall-clock instant until which `refreshPicker()` is a no-op. Set by
   *  any programmatic mutation (chip pick, mention swap) that would
   *  otherwise trigger the @-picker to flicker open through `input`,
   *  `focus-restore`, `selectionchange`, and Radix's close-animation
   *  cascade. A short window is enough — user keystrokes after this
   *  resume normal picker behaviour. */
  const pickerSuppressedUntil = useRef(0);
  const [popoverChip, setPopoverChip] = useState<HTMLButtonElement | null>(null);
  /** True between popover-trigger (open) and Radix's final `onOpenChange(false)`.
   *  Decoupling "is the popover shown" from "which chip's data to render"
   *  prevents the popover body from blanking to "No options" + Custom
   *  field during the close — `popoverChip` stays non-null through the
   *  whole close cycle so chipOptions/chipSelected stay valid, and the
   *  virtualRef stays anchored at the correct chip (no jump-to-corner). */
  const [chipPopoverOpen, setChipPopoverOpen] = useState(false);
  /** Mention pill the user clicked, opens a popover with the other refs
   *  so they can switch the active reference without deleting + retyping. */
  const [popoverMention, setPopoverMention] = useState<HTMLSpanElement | null>(null);
  const [mentionPopoverOpen, setMentionPopoverOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [picker, setPicker] = useState<PickerState | null>(null);

  // Combine builder-supplied mentionables with registry entries so typing
  // `@b` surfaces `@business` alongside `@reference1`.
  const allMentionables = useMemo<PromptComposerMention[]>(() => {
    const out: PromptComposerMention[] = [...mentionables];
    for (const name of Object.keys(registry)) {
      out.push({ key: `@${name}`, label: `type: ${name}`, category: 'type' });
    }
    return out;
  }, [mentionables, registry]);

  // Set of @-keys the parser recognises as plain mentions (not chips).
  // Anything not in this set AND not in `registry` gets stripped at parse.
  const knownMentionsForParse = useMemo(
    () => new Set(mentionables.map((m) => m.key)),
    [mentionables],
  );

  // -------------------------------------------------------------------------
  // External value → DOM sync.
  // -------------------------------------------------------------------------
  useLayoutEffect(() => {
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    const el = editableRef.current;
    if (!el) return;
    const segments = parseTemplate(value, registry, knownMentionsForParse);
    el.innerHTML = segmentsToHTML(segments);
  }, [value, registry, knownMentionsForParse]);

  // -------------------------------------------------------------------------
  // DOM → template emit.
  // -------------------------------------------------------------------------
  const emitFromDom = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    const segs = readDomToSegments(el);
    const next = segmentsToTemplate(segs);
    if (next === value) return;
    skipNextSync.current = true;
    onChange(next);
  }, [onChange, value]);

  // -------------------------------------------------------------------------
  // Picker state — opens whenever caret sits right after an `@<word>` token.
  // -------------------------------------------------------------------------
  const refreshPicker = useCallback(() => {
    if (performance.now() < pickerSuppressedUntil.current) {
      setPicker(null);
      return;
    }
    const el = editableRef.current;
    if (!el || allMentionables.length === 0) {
      setPicker(null);
      return;
    }
    const before = getTextBeforeCaret(el);
    if (before === null) {
      setPicker(null);
      return;
    }
    // `@` ALONE matches — the `\w*` capture group is greedy but accepts
    // zero chars after the @, so the picker opens the instant the user
    // hits `@` with an empty filter.
    const m = /(@\w*)$/.exec(before);
    if (!m) {
      setPicker(null);
      return;
    }
    const rect = getCaretRect();
    if (!rect) {
      setPicker(null);
      return;
    }
    setPicker((prev) => ({
      rect,
      filter: m[1].slice(1).toLowerCase(),
      activeIndex: prev?.activeIndex ?? 0,
    }));
  }, [allMentionables.length]);

  useEffect(() => {
    if (!picker) return;
    const onSelectionChange = () => refreshPicker();
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [picker, refreshPicker]);

  const filteredItems = useMemo(() => {
    if (!picker) return [] as PromptComposerMention[];
    const f = picker.filter;
    return allMentionables
      .filter((m) => m.key.toLowerCase().slice(1).includes(f))
      .slice(0, 8);
  }, [picker, allMentionables]);

  const closePicker = useCallback(() => setPicker(null), []);

  const commitMention = useCallback((m: PromptComposerMention) => {
    const el = editableRef.current;
    if (!el || !picker) return;
    // Range-based extraction so chip widgets contribute their resolved text
    // exactly as they appear to the user, matching `value`'s projection.
    const before = getTextBeforeCaret(el) ?? '';
    const after = getTextAfterCaret(el);
    const start = before.length - (1 + picker.filter.length);
    const sep = after.startsWith(' ') ? '' : ' ';
    const next = before.slice(0, start) + m.key + sep + after;
    closePicker();
    skipNextSync.current = false; // force re-render so the new mention parses
    onChange(next);
  }, [picker, onChange, closePicker]);

  // -------------------------------------------------------------------------
  // Event handlers — input / click (chip popover) / keydown (picker nav).
  // -------------------------------------------------------------------------
  const handleInput = useCallback(() => {
    // Sync the template back; deliberately DON'T touch the picker here.
    // `input` fires for both user typing AND programmatic mutations
    // (chip pick, mention swap), so any picker logic here flickers on
    // chip closes. Picker refresh moves to `onKeyUp` — fires only after
    // a real user keystroke, never on a programmatic textContent change.
    emitFromDom();
  }, [emitFromDom]);

  const handleKeyUp = useCallback(() => {
    refreshPicker();
  }, [refreshPicker]);

  const handleClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = ev.target as HTMLElement;
    const chipEl = target.closest('button[data-chip="1"]') as HTMLButtonElement | null;
    if (chipEl) {
      ev.preventDefault();
      // Toggle: clicking the same chip a second time closes the popover
      // instead of reopening it as a no-op. The portal's click-outside
      // handler ignores clicks on the anchor (so it doesn't close itself
      // mid-open), so the close has to happen here explicitly.
      if (chipPopoverOpen && popoverChip === chipEl) {
        setChipPopoverOpen(false);
        setPopoverChip(null);
        setCustomDraft('');
        return;
      }
      setPicker(null);
      setCustomDraft('');
      setPopoverChip(chipEl);
      setChipPopoverOpen(true);
      return;
    }
    const mentionEl = target.closest('span[data-mention="1"]') as HTMLSpanElement | null;
    if (mentionEl) {
      ev.preventDefault();
      if (mentionPopoverOpen && popoverMention === mentionEl) {
        setMentionPopoverOpen(false);
        setPopoverMention(null);
        return;
      }
      setPicker(null);
      setPopoverMention(mentionEl);
      setMentionPopoverOpen(true);
    }
  }, [readOnly, chipPopoverOpen, popoverChip, mentionPopoverOpen, popoverMention]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!picker || filteredItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPicker({ ...picker, activeIndex: Math.min(picker.activeIndex + 1, filteredItems.length - 1) });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPicker({ ...picker, activeIndex: Math.max(picker.activeIndex - 1, 0) });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commitMention(filteredItems[picker.activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    }
  }, [picker, filteredItems, commitMention, closePicker]);

  // -------------------------------------------------------------------------
  // Chip popover — option + custom-value commit.
  // -------------------------------------------------------------------------
  const chipOptions: string[] = useMemo(() => {
    if (!popoverChip) return [];
    try {
      const raw = popoverChip.dataset.options ?? '[]';
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }, [popoverChip]);
  const chipSelected = popoverChip?.dataset.selected ?? '';

  const pickOption = useCallback((next: string) => {
    if (!popoverChip || !editableRef.current) return;
    // 250ms covers the full close cascade: `input` from `textContent=`,
    // Radix close-animation + focus-restore, the trailing `selectionchange`.
    pickerSuppressedUntil.current = performance.now() + 250;
    popoverChip.dataset.selected = next;
    const firstChild = popoverChip.firstChild;
    if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
      firstChild.textContent = next;
    } else {
      popoverChip.insertBefore(document.createTextNode(next), popoverChip.firstChild);
    }
    setChipPopoverOpen(false);          // start close; popoverChip stays
    setCustomDraft('');
    emitFromDom();
  }, [popoverChip, emitFromDom]);

  const commitCustom = useCallback(() => {
    const t = customDraft.trim();
    if (t.length === 0) return;
    pickOption(t);
  }, [customDraft, pickOption]);

  // -------------------------------------------------------------------------
  // Mention-pill popover — clicking on `@reference1` opens a list of the
  // other available references so the user can swap which one is bound to
  // that spot without deleting + retyping.
  // -------------------------------------------------------------------------
  const referenceMentionables = useMemo(
    () => mentionables.filter((m) => m.category === 'reference'),
    [mentionables],
  );

  const swapMention = useCallback((nextKey: string) => {
    if (!popoverMention || !editableRef.current) return;
    pickerSuppressedUntil.current = performance.now() + 250;
    popoverMention.dataset.key = nextKey;
    popoverMention.textContent = nextKey;
    setMentionPopoverOpen(false);       // start close; popoverMention stays
    emitFromDom();
  }, [popoverMention, emitFromDom]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  // Hard gate: never render the @-picker while another overlay (chip
  // popover, mention-swap popover) is open. Belt-and-suspenders so even
  // if some event briefly flips `picker` non-null during a close
  // animation, nothing visible escapes.
  const anyOverlayOpen = chipPopoverOpen || mentionPopoverOpen;
  const showPicker = picker !== null && filteredItems.length > 0 && !anyOverlayOpen;

  return (
    <>
      <div
        ref={editableRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyUp={handleKeyUp}
        onBlur={emitFromDom}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        data-placeholder={placeholder ?? ''}
        className="prompt-composer"
      />

      {/* `@`-picker — fixed-position floating list anchored to the caret
          coords. Portalled to <body> so it lives outside any parent
          stacking context (Cards / panels with `transform` etc. would
          otherwise trap it below sibling panels regardless of z-index). */}
      {showPicker ? createPortal(
        <div
          role="listbox"
          className="prompt-picker"
          style={{ left: picker.rect.x, top: picker.rect.y + 4 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="prompt-picker-header">
            <AtSign className="size-3" />
            <span>References{picker.filter ? ` · ${picker.filter}` : ''}</span>
          </div>
          <div className="prompt-picker-list">
            {filteredItems.map((item, i) => (
              <button
                key={item.key}
                type="button"
                onClick={() => commitMention(item)}
                data-active={i === picker.activeIndex ? 'true' : undefined}
                className="prompt-picker-item"
              >
                <span className="truncate">{item.key}</span>
                <span className="prompt-picker-item-label">{item.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}

      {/* Mention-edit popover — clicking `@reference1` opens a list of the
          other refs so the user can swap. Same Radix instance pattern as
          the chip popover; anchored at the clicked pill via virtualRef. */}
      <Popover
        open={mentionPopoverOpen}
        onOpenChange={(o) => {
          setMentionPopoverOpen(o);
          if (!o) setPopoverMention(null); // clear AFTER Radix is done
        }}
      >
        <PopoverAnchor virtualRef={popoverMention ? { current: popoverMention } : undefined} />
        <PopoverContent className="w-[240px] p-1 data-[state=closed]:hidden" align="start" sideOffset={6}>
          <div className="prompt-picker-header">
            <AtSign className="size-3" />
            <span>Swap reference</span>
          </div>
          <div className="prompt-picker-list">
            {referenceMentionables.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No references</p>
            ) : referenceMentionables.map((m) => {
              const active = popoverMention?.dataset.key === m.key;
              return (
                <Button
                  key={m.key}
                  type="button"
                  variant={active ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => swapMention(m.key)}
                  className="justify-start gap-2 px-2 py-1.5 h-auto text-xs font-normal"
                >
                  <Check
                    className={['size-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0'].join(' ')}
                  />
                  <span className="truncate text-left">{m.key}</span>
                </Button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Chip-edit popover — plain createPortal'd div anchored at the
          clicked chip's bounding rect. Was a Radix Popover before; Radix's
          close-animation lifecycle produced an unavoidable single-frame
          render of empty/stale content during close. With our own div we
          control mount/unmount + position entirely — open = mount, close
          = unmount, no animation, nothing to flicker. */}
      {chipPopoverOpen && popoverChip ? createPortal(
        <ChipPopoverPanel
          anchor={popoverChip}
          options={chipOptions}
          selected={chipSelected}
          customDraft={customDraft}
          onCustomDraftChange={setCustomDraft}
          onPick={pickOption}
          onCommitCustom={commitCustom}
          onClose={() => {
            setChipPopoverOpen(false);
            setPopoverChip(null);
            setCustomDraft('');
          }}
        />,
        document.body,
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ChipPopoverPanel — plain fixed-position chip-edit popover.
//
// Anchored at the clicked chip's bounding rect; closed by clicking outside.
// No animations, no Radix lifecycle. Listed AFTER PromptComposer so the
// import order is parent-first; React doesn't care, but it reads naturally.
// ---------------------------------------------------------------------------

interface ChipPopoverPanelProps {
  anchor: HTMLButtonElement;
  options: string[];
  selected: string;
  customDraft: string;
  onCustomDraftChange: (next: string) => void;
  onPick: (next: string) => void;
  onCommitCustom: () => void;
  onClose: () => void;
}

function ChipPopoverPanel({
  anchor,
  options,
  selected,
  customDraft,
  onCustomDraftChange,
  onPick,
  onCommitCustom,
  onClose,
}: ChipPopoverPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure once when the anchor changes; the popover doesn't reflow during
  // its lifetime (no scroll-on-open, no resize follow). If those become
  // requirements, attach a scroll/resize listener and re-measure.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
  }, [anchor]);

  // Click-outside / Escape to dismiss. `mousedown` (not `click`) so a drag
  // started outside doesn't keep us open when the mouse lifts inside.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = e.target as Node | null;
      if (target && (panel.contains(target) || anchor.contains(target))) return;
      onClose();
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [anchor, onClose]);

  if (!pos) return null;

  return (
    <div
      ref={panelRef}
      role="listbox"
      className="fixed z-50 w-[280px] rounded-md border bg-popover text-popover-foreground shadow-md p-1"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex flex-col gap-0.5 max-h-[240px] overflow-y-auto">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No options</p>
        ) : options.map((opt) => {
          const isSelected = opt === selected;
          return (
            <Button
              key={opt}
              type="button"
              variant={isSelected ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onPick(opt)}
              className="justify-start gap-2 px-2 py-1.5 h-auto text-xs font-normal"
            >
              <Check className={['size-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0'].join(' ')} />
              <span className="truncate text-left">{opt}</span>
            </Button>
          );
        })}
      </div>
      <div className="mt-2 px-1 pb-1">
        <div className="field-wrap py-1">
          <input
            type="text"
            value={customDraft}
            onChange={(e) => onCustomDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommitCustom();
              }
            }}
            className="field-input"
            placeholder="Custom value…"
          />
          <button
            type="button"
            onClick={onCommitCustom}
            disabled={customDraft.trim().length === 0}
            className="shrink-0 rounded-md bg-brand px-2 py-0.5 text-[11px] font-semibold text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default PromptComposer;
