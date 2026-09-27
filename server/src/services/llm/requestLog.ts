// Build the human-readable prompt/response text stored in the per-key request
// log. Images/files are stripped (we never store base64 blobs), and each side
// is truncated to CAP bytes.

const CAP = 8192;

function trunc(s: string): string {
  return s.length > CAP ? `${s.slice(0, CAP)}\n…[truncated ${s.length - CAP} chars]` : s;
}

/** OpenAI content can be a string or an array of parts; images become a marker. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if (o.type === 'image_url' || o.image_url) return '[image]';
        if (o.type === 'file' || o.type === 'input_file' || o.file || o.file_data) return '[file]';
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Flatten the request body (OpenAI or Ollama chat, or /generate) into text. */
export function buildPromptText(body: unknown): string {
  try {
    const b = (body ?? {}) as Record<string, unknown>;
    if (Array.isArray(b.messages)) {
      return trunc(
        (b.messages as Record<string, unknown>[])
          .map((m) => {
            const role = typeof m?.role === 'string' ? m.role : '?';
            const text = partsToText(m?.content);
            const imgs = Array.isArray(m?.images) && m.images.length
              ? ` ${'[image]'.repeat(m.images.length as number)}` : '';
            return `${role}: ${text}${imgs}`.trim();
          })
          .join('\n'),
      );
    }
    if (typeof b.prompt === 'string') return trunc(b.prompt);
  } catch { /* fall through */ }
  return '';
}

/**
 * Reassemble the response text from the raw upstream body. Handles non-stream
 * JSON, OpenAI SSE (`data: {delta}`), and Ollama NDJSON (`{message}`/`{response}`).
 */
export function reassembleResponse(raw: string, mode: 'ollama' | 'openai', isStream: boolean): string {
  try {
    if (!isStream) {
      const j = JSON.parse(raw) as Record<string, any>;
      const c = mode === 'openai'
        ? j?.choices?.[0]?.message?.content
        : (j?.message?.content ?? j?.response);
      return trunc(typeof c === 'string' ? c : JSON.stringify(j).slice(0, CAP));
    }
    let out = '';
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let payload = s;
      if (mode === 'openai') {
        if (!s.startsWith('data:')) continue;
        payload = s.slice(5).trim();
        if (payload === '[DONE]') break;
      }
      try {
        const j = JSON.parse(payload) as Record<string, any>;
        const piece = mode === 'openai'
          ? j?.choices?.[0]?.delta?.content
          : (j?.message?.content ?? j?.response);
        if (typeof piece === 'string') out += piece;
      } catch { /* skip unparseable line */ }
      if (out.length > CAP) break;
    }
    return trunc(out || raw);
  } catch {
    return trunc(raw);
  }
}
