// Single source of truth for every string Studio sends to an LLM as
// instruction or feedback — auto-title, summarization, tool descriptions,
// tool result/error templates, dispatcher re-prompts. Consolidated here so
// the prompts that drive model behavior can be tuned in one place instead
// of being scattered across 6+ files.
//
// **Server-only.** Don't import from the UI bundle. The frontend never
// needs these strings — the LLM is hit from the server.
//
// Future work: load overrides from `settings.getChatPrompts()` so users
// can tweak prompts in Settings UI without a redeploy. For now everything
// is exported as a constant or template function.

// ===== Auto-title =====
// Generated after the first assistant turn so a freshly-created conversation
// gets a meaningful sidebar label. Length cap (80 chars) + sanitization
// (quote/punctuation strip) live in autoTitle.ts; the prompt only steers
// shape and content here.
export const TITLE_PROMPT = (userText: string, assistantText: string): string =>
  'Summarize this conversation in 4-6 words as a title. '
  + 'Reply with ONLY the title, no quotes, no punctuation. The conversation: '
  + userText.slice(0, 600) + ' ' + assistantText.slice(0, 600);

// ===== Context-compact (summarize-strategy + manual /compact) =====
export const COMPACT_SUMMARY_PROMPT_PREFIX = 'Summarize the following conversation '
  + 'in approximately 200 words. Preserve the key topics, decisions, and any '
  + 'pending questions. Reply with ONLY the summary, no preamble. The '
  + 'conversation:\n\n';

// Wrapper text the model sees on subsequent turns after a summary replaces
// the original transcript. Two callers — manual compact + sliding-strategy
// summary fallback — must use the same wording so the model treats them
// identically across runs.
export const COMPACT_SUMMARY_WRAP = (summary: string): string =>
  `Conversation summary so far: ${summary}`;

// ===== Tool descriptions =====
// These are the strings the model reads to decide when/how to call each
// tool. Wording here directly affects tool-calling behavior — heavy hand
// makes models call too eagerly, light hand misses opportunities.

export const TOOL_DESCRIPTION_WEB_SEARCH = 'Search the public web via a SearXNG '
  + 'metasearch engine. Returns a numbered list of titles, URLs, and '
  + 'snippets — use the URLs as citations when answering the user.';

export const TOOL_DESCRIPTION_RAG_SEARCH = 'Search the user\'s RAGFlow knowledge '
  + 'bases for relevant chunks. Each result includes the source document name '
  + 'plus the matching text — quote the chunks back when answering and cite '
  + 'the source document name.';

export const TOOL_DESCRIPTION_RAG_UPLOAD = 'Upload a publicly reachable file URL '
  + 'into a RAGFlow knowledge base. The file is downloaded server-side and '
  + 'forwarded to RAGFlow which queues it for chunking + embedding '
  + 'asynchronously.';

export const TOOL_DESCRIPTION_GENERATE_IMAGE = 'Start an image generation in '
  + 'Studio using a ComfyUI template workflow. Returns the prompt_id '
  + 'immediately; the rendered image will appear inline in the chat thread '
  + 'as soon as ComfyUI finishes. Acknowledge the user briefly (one short '
  + 'sentence). Do NOT tell the user to open or navigate to the gallery — '
  + 'the image is shown right there in the chat.';

// ===== Human-friendly tool labels =====
// UI-facing labels (Tools popover in the composer). Server returns these
// to the UI via /api/chat/tools. Description is shorter than the LLM-facing
// version above — different audience.
export const TOOL_LABELS = {
  web_search:     'Web search',
  rag_search:     'RAG search',
  rag_upload:     'RAG upload',
  generate_image: 'Generate image',
} as const;

export const TOOL_LABEL_DESCRIPTIONS = {
  web_search:     'Search the public web via SearXNG and cite results.',
  rag_search:     'Search your RAGFlow knowledge bases for relevant chunks.',
  rag_upload:     'Upload a public file URL into a RAGFlow knowledge base.',
  generate_image: 'Generate an image via a ComfyUI template workflow.',
} as const;

// ===== Tool result templates =====
// Strings the model reads back after a tool runs. These are essentially
// re-prompts: they tell the model what just happened and how to respond.
// Heavy steering text lives here so it's tunable.

export interface GenerateImageResultArgs {
  templateName: string;
  promptId: string;
  fieldNote: string;
}

export const GENERATE_IMAGE_QUEUED_RESULT = (args: GenerateImageResultArgs): string =>
  `Image generation queued.\n`
  + `template: ${args.templateName}\n`
  + `prompt_id: ${args.promptId}${args.fieldNote}\n`
  + 'The rendered image will appear inline in this chat as soon as '
  + 'ComfyUI finishes — no navigation needed. Reply with one short '
  + 'sentence acknowledging the request. Do NOT instruct the user '
  + 'to open the gallery, do NOT describe the image, do NOT mention '
  + 'DALL-E / Midjourney / "uploading" / "self-image".';

export const GENERATE_IMAGE_PROMPT_FIELD_NOTE = (fieldId: string): string =>
  ` (prompt routed to field "${fieldId}")`;

export const GENERATE_IMAGE_NO_FIELD_NOTE = ' (no prompt-shaped field; template defaults applied)';

export const GENERATE_IMAGE_FAILED_PREFIX = 'generate_image failed: ';

export const GENERATE_IMAGE_NO_TEMPLATE_ERROR = 'generate_image failed: no '
  + 'template selected and no default image template is configured. Ask the '
  + 'user to set a default in Settings → Tools, or pass an explicit '
  + '`template` argument.';

export const RAG_SEARCH_NO_KB_ERROR = 'rag_search failed: knowledge_base_id is '
  + 'required. Ask the user which knowledge base to search before retrying.';

// ===== Tool dispatcher =====
// Re-prompt fed back to the LLM when a tool execution throws. The dispatcher
// continues the loop; the model sees this string in place of a tool result
// so it can apologize / retry / pick a different tool.
export const TOOL_ERROR_REPROMPT = (errorMessage: string): string =>
  `tool error: ${errorMessage}`;
