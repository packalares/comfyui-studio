// Shared storage for per-prompt metadata (provenance + fingerprints).
// Extracted into its own module to break the circular dependency between
// gallery.sentry.ts (which calls gallery.service.ts) and gallery.service.ts
// (which needs the meta map populated by gallery.sentry.ts callers).

export interface PromptMeta {
  triggeredBy?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  modelFingerprint?: string | null;
  templateHash?: string | null;
}

const promptMeta = new Map<string, PromptMeta>();

export function setPromptMeta(promptId: string, meta: PromptMeta): void {
  promptMeta.set(promptId, meta);
}

export function getPromptMeta(promptId: string): PromptMeta | undefined {
  return promptMeta.get(promptId);
}

export function clearPromptMeta(promptId: string): void {
  promptMeta.delete(promptId);
}

/** Test-only: clear all stored metadata. */
export function _clearAllPromptMetaForTests(): void {
  promptMeta.clear();
}
