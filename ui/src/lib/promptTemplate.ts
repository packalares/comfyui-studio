// Prompt template parser + resolver.
//
// Templates carry three flavours of token alongside plain text:
//
//   {a|[b]|c}       Inline chip. Self-contained: options live in the token,
//                   `[bracket]` marks the current pick.
//
//   @name(pick)?    Named chip. Options come from the registry passed in.
//                   `@name` alone defaults to the registry's first option;
//                   `@name(pick)` carries a specific pick. Custom values
//                   that aren't in the registry round-trip in the parens.
//
//   @mention        Plain mention (image reference, mode trigger). Not a
//                   chip — just visually highlighted at render time, and
//                   preserved verbatim through resolution so the engine
//                   downstream can do its own `@reference1` expansion.
//
//   @unknown        Names that are neither registered nor in the known-
//                   mentions set get DROPPED. Keeps presets from leaving
//                   broken `@xxxx` text when a referenced type isn't set
//                   up locally.
//
// The PromptComposer renders these as DOM, but the parsing logic is pure
// so it can also run at submit time to build the final prompt string.

export type Segment =
  | { kind: 'text'; text: string }
  | {
      kind: 'chip';
      options: string[];
      selected: string;
      /** Registry name when this came from `@name(pick)`; undefined for `{…|…}`. */
      tokenName?: string;
    }
  | { kind: 'mention'; key: string };

export type PromptRegistry = Record<string, string[]>;

const INLINE_RE = /\{([^{}]+?\|[^{}]+?)\}/g;
const NAMED_RE = /@(\w+)(?:\(([^()]*)\))?/g;

interface Match {
  start: number;
  end: number;
  segment: Segment | null;
}

function parseInline(text: string): Match[] {
  const out: Match[] = [];
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    let selected = '';
    const options = m[1].split('|').map((p) => {
      const t = p.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        const v = t.slice(1, -1);
        selected = v;
        return v;
      }
      return t;
    });
    if (!selected) selected = options[0] ?? '';
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { kind: 'chip', options, selected },
    });
  }
  return out;
}

function parseNamed(
  text: string,
  registry: PromptRegistry,
  knownMentions: Set<string>,
): Match[] {
  const out: Match[] = [];
  NAMED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_RE.exec(text)) !== null) {
    const name = m[1];
    const pick = m[2];
    const fullKey = `@${name}`;
    const start = m.index;
    const end = m.index + m[0].length;
    const options = registry[name];
    if (options && options.length > 0) {
      const selected = pick && pick.length > 0 ? pick : options[0];
      out.push({
        start,
        end,
        segment: { kind: 'chip', options, selected, tokenName: name },
      });
    } else if (knownMentions.has(fullKey)) {
      // Strip any `(…)` from the inserted text — `@reference1` isn't meant
      // to carry args. `@reference1(foo)` becomes plain `@reference1`.
      out.push({ start, end, segment: { kind: 'mention', key: fullKey } });
    } else {
      // Unknown — drop the match entirely (segment: null).
      out.push({ start, end, segment: null });
    }
  }
  return out;
}

/** Parse a template into a flat segment list. */
export function parseTemplate(
  template: string,
  registry: PromptRegistry,
  knownMentions: Iterable<string>,
): Segment[] {
  if (template.length === 0) return [];
  const mentionSet = knownMentions instanceof Set
    ? knownMentions
    : new Set(knownMentions);
  const matches: Match[] = [...parseInline(template), ...parseNamed(template, registry, mentionSet)];
  matches.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlap — keep the earlier one
    if (m.start > cursor) out.push({ kind: 'text', text: template.slice(cursor, m.start) });
    if (m.segment) out.push(m.segment);
    cursor = m.end;
  }
  if (cursor < template.length) out.push({ kind: 'text', text: template.slice(cursor) });
  return out;
}

/** Inverse of `parseTemplate`. Used to serialise after a DOM mutation. */
export function segmentsToTemplate(segments: Segment[]): string {
  let out = '';
  for (const s of segments) {
    if (s.kind === 'text') {
      out += s.text;
      continue;
    }
    if (s.kind === 'mention') {
      out += s.key;
      continue;
    }
    if (s.tokenName) {
      // Registry chip. Drop the `(pick)` when the pick equals the registry's
      // first option (the default) — keeps templates tidy.
      const defaultOpt = s.options[0];
      if (s.selected === defaultOpt) {
        out += `@${s.tokenName}`;
      } else {
        out += `@${s.tokenName}(${s.selected})`;
      }
      continue;
    }
    // Inline chip. If the selected value isn't in the original options
    // (user typed Custom), splice it in as the new bracketed default.
    const inOptions = s.options.includes(s.selected);
    const opts = inOptions
      ? s.options.map((o) => (o === s.selected ? `[${o}]` : o))
      : [...s.options, `[${s.selected}]`];
    out += `{${opts.join('|')}}`;
  }
  return out;
}

/** Resolve a template against the registry + known-mentions context into
 *  the final prompt string the engine sees. Chip tokens become their
 *  selected value; mentions pass through verbatim; unknown `@xxx` is
 *  stripped. */
export function resolvePromptTemplate(
  template: string,
  registry: PromptRegistry,
  knownMentions: Iterable<string>,
): string {
  const segs = parseTemplate(template, registry, knownMentions);
  let out = '';
  for (const s of segs) {
    if (s.kind === 'text') out += s.text;
    else if (s.kind === 'mention') out += s.key;
    else out += s.selected;
  }
  return out;
}

/** Resolve ONLY inline `{a|[b]|c}` choice tokens; leaves `@name` and
 *  unknown mentions verbatim. Used by surfaces that don't carry a prompt
 *  registry or known-mention set (e.g. VideoBuilder's plain textarea) but
 *  still want choice substitution before submit. */
export function resolveInlineChoices(template: string): string {
  INLINE_RE.lastIndex = 0;
  return template.replace(INLINE_RE, (_full, body: string) => {
    let chosen = '';
    const options = body.split('|').map((p) => {
      const t = p.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        const v = t.slice(1, -1);
        chosen = v;
        return v;
      }
      return t;
    });
    return chosen || options[0] || '';
  });
}

/** True if `template` contains any token (`{…|…}`, `@name`, etc.) — used
 *  by callers that want to skip token-aware UI for pure-text prompts. */
export function templateHasTokens(template: string): boolean {
  INLINE_RE.lastIndex = 0;
  if (INLINE_RE.test(template)) return true;
  NAMED_RE.lastIndex = 0;
  return NAMED_RE.test(template);
}
