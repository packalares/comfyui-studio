// Chat suggestion strings — empty-state quick-start pills (rendered when
// the user opens a fresh chat) and contextual follow-ups (rendered under
// the latest assistant message based on its shape).
//
// **UI-only.** These are pure frontend display strings — they're never
// sent to the LLM as instructions. The pills are clicked → the text is
// sent as a fresh user turn (so the *user* speaks them, not the system).
//
// Edit this file to customize what the user sees. Future enhancement:
// surface in Settings UI so users can curate their own suggestions
// without a redeploy.

// Shown on the empty-state hero ("What can I help with?") when the user
// opens a fresh chat with no conversation selected. Click a pill → sends
// it as a user message via the standard send path.
export const EMPTY_STATE_PROMPTS: readonly string[] = [
  'Generate an image of a cyberpunk city at night',
  'Search the web for the latest local LLM benchmarks',
  'Search my docs for setup instructions',
  'Explain this code',
  'Brainstorm names for a new project',
  'Summarize a topic for me',
];

// Contextual follow-up suggestions rendered under the most recent assistant
// message. Picked statically based on the reply's shape (no extra LLM call).
// `deriveSuggestions` in `messageParts.ts` reads from these arrays.
export const CONTEXTUAL_SUGGESTIONS = {
  // Assistant produced a code block.
  codeFenced: ['Explain this code', 'Write a unit test for it'] as const,
  // Assistant ended with a question — surface common affirmation replies.
  question: ['Yes, please', 'No thanks', 'Tell me more'] as const,
  // Assistant included external URLs.
  urlBearing: ['Summarize the linked sources'] as const,
  // Generic fallback for plain-prose answers.
  fallback: ['Tell me more', 'Give me an example'] as const,
  // Appended to the fallback when the assistant's reply is long (>400 chars).
  longReplyExtra: 'Summarize this',
} as const;
