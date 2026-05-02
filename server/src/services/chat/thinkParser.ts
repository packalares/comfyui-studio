// Streaming `<think>...</think>` splitter. Some Ollama models (DeepSeek-R1,
// Qwen QwQ, etc.) embed chain-of-thought inside `<think>` tags on the same
// content stream. The UI renders that separately from regular content via
// `chat:reasoning` envelopes, so we intercept the deltas here and route the
// inside / outside fragments to two callbacks.
//
// Also exposes `composeAssistantParts(toolParts, reasoning, content)` —
// streamChat.ts calls it to build the persisted message-parts array in the
// same shape on both the success and error paths.
//
// The parser is deliberately tag-only: it never re-emits the literal `<think>`
// or `</think>` tokens, and survives a tag arriving split across multiple
// chunks (`<thi` then `nk>`). It also tolerates models that switch in and out
// of think-mode multiple times during a single turn.
//
// `feed(delta)` is called for every NDJSON delta on the upstream stream;
// `flush()` is called once on stream end so any buffered partial-tag tail is
// surfaced as plain content (better than silently dropping it).

const OPEN = '<think>';
const CLOSE = '</think>';

export type ThinkParserSink = {
  onContent: (delta: string) => void;
  onReasoning: (delta: string) => void;
};

export class ThinkParser {
  private inThink = false;
  // Buffer holds at most the longest tag length minus one, so we never split
  // a tag across emits. We flush as soon as we know the next char(s) cannot
  // complete a tag.
  private buffer = '';
  private readonly sink: ThinkParserSink;

  constructor(sink: ThinkParserSink) {
    this.sink = sink;
  }

  feed(delta: string): void {
    if (delta.length === 0) return;
    this.buffer += delta;
    this.drain();
  }

  /** Flush any buffered tail. Call once when the upstream stream completes. */
  flush(): void {
    if (this.buffer.length === 0) return;
    if (this.inThink) {
      this.sink.onReasoning(this.buffer);
    } else {
      this.sink.onContent(this.buffer);
    }
    this.buffer = '';
  }

  // Helper used by streamChat.ts to build the persisted message-parts array.
  // Keeps the reasoning + text part insertion in one place so the success +
  // error paths stay in sync.
  static composeAssistantParts(
    toolParts: unknown[], reasoning: string, content: string,
  ): unknown[] {
    const out: unknown[] = [...toolParts];
    if (reasoning.length > 0) out.push({ type: 'reasoning', text: reasoning });
    out.push({ type: 'text', text: content });
    return out;
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      const tag = this.inThink ? CLOSE : OPEN;
      const idx = this.buffer.indexOf(tag);
      if (idx >= 0) {
        // Emit everything up to the tag, switch state, drop the tag.
        const before = this.buffer.slice(0, idx);
        if (before.length > 0) {
          if (this.inThink) this.sink.onReasoning(before);
          else this.sink.onContent(before);
        }
        this.buffer = this.buffer.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // No full tag in buffer. Hold back enough trailing characters to let a
      // partial tag complete on the next feed; emit the rest immediately so
      // the UI keeps streaming smoothly.
      const safeLen = this.buffer.length - (tag.length - 1);
      if (safeLen <= 0) return;
      const safe = this.buffer.slice(0, safeLen);
      if (this.inThink) this.sink.onReasoning(safe);
      else this.sink.onContent(safe);
      this.buffer = this.buffer.slice(safeLen);
      return;
    }
  }
}
