// Separate module to break the service↔sentry circular dependency.
// Both modules need prompt metadata, but service imports sentry (for appendHistoryEntry)
// and sentry imports service (for appendHistoryEntry). This shared atom severs the cycle.

export interface PromptMeta {
  triggeredBy?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  modelFingerprint?: string | null;
  templateHash?: string | null;
  /**
   * Studio template slug the prompt was submitted under. Threaded through
   * so the gallery row can record `templateName` at WS-event time — the
   * snapshot also carries it as the durable fallback.
   */
  templateName?: string | null;
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

/** Test-only. */
export function _clearAllPromptMetaForTests(): void {
  promptMeta.clear();
}
