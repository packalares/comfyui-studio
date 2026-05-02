// Phase F strategy enforcement bridge — invoked by streamChat.ts before
// firing the request so context-window management runs uniformly across
// streaming + tool-dispatch paths. Lives apart from streamChat.ts to keep
// that file under the 250-line cap.

import { logger } from '../../lib/logger.js';
import { computeUsage } from './contextWindow.js';
import { applySlidingWindow, applySummarizeStrategy } from './contextCompact.js';
import { emitChatEvent } from './broadcaster.js';
import type { OllamaChatMessage } from './ollamaChat.js';

// Threshold above which the configured strategy kicks in. Below 80% the
// in-flight messages pass through untouched.
const HIGH_WATER_PERCENT = 80;
// Sliding-window target; 70% leaves headroom for the new turn + reply.
const SLIDING_TARGET_PERCENT = 70;

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
  if (usage.percent < HIGH_WATER_PERCENT) return args.messages;

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
      args.messages, usage.budget, usage.used, SLIDING_TARGET_PERCENT,
    );
  }
  // 'summarize' — best effort; falls back to the original list on upstream
  // failure so the user's send still goes through.
  return applySummarizeStrategy(args.messages, args.baseUrl, args.model);
}
