// Phase F strategy enforcement bridge — invoked by streamChat.ts before
// firing the request so context-window management runs uniformly across
// streaming + tool-dispatch paths. Lives apart from streamChat.ts to keep
// that file under the 250-line cap.

import { logger } from '../../lib/logger.js';
import { computeUsage } from './contextWindow.js';
import { applySlidingWindow, applySummarizeStrategy } from './contextCompact.js';
import { emitChatEvent } from './broadcaster.js';
import * as settings from '../settings.js';
import type { OllamaChatMessage } from './ollamaChat.js';

export interface EnforceContextArgs {
  conversationId: string;
  model: string;
  baseUrl: string;
  pendingUserText: string;
  messages: OllamaChatMessage[];
  msgId: string;
}

export async function enforceContextStrategy(
  args: EnforceContextArgs,
): Promise<OllamaChatMessage[]> {
  let usage;
  try {
    usage = await computeUsage({
      conversationId: args.conversationId,
      model: args.model,
      pendingUserText: args.pendingUserText,
    });
  } catch (err) {
    logger.warn('context-usage probe failed', {
      conversationId: args.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return args.messages;
  }
  if (usage.percent < settings.getChatHighWaterPercent()) return args.messages;

  if (usage.strategy === 'manual') {
    emitChatEvent({
      type: 'chat:warning',
      data: {
        msgId: args.msgId,
        warning: 'context-near-full',
        percent: usage.percent,
        used: usage.used,
        budget: usage.budget,
      },
    });
    return args.messages;
  }
  if (usage.strategy === 'sliding') {
    return applySlidingWindow(
      args.messages, usage.budget, usage.used, settings.getChatSlidingTargetPercent(),
    );
  }
  // 'summarize' — best effort; falls back to the original list on upstream
  // failure so the user's send still goes through.
  return applySummarizeStrategy(args.messages, args.baseUrl, args.model);
}
