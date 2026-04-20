// ComfyUI restart hook used by install.service + uninstall.service.
// Delegates to the shared singleton ProcessService so there is exactly one
// restart state machine in the process. Failures are logged but never thrown
// — a restart that fails must not roll back a successful install.

import { logger } from '../../lib/logger.js';
import { getProcessService } from '../comfyui/singleton.js';

export async function triggerRestart(reason: string): Promise<void> {
  try {
    const svc = getProcessService();
    const result = await svc.restartComfyUI();
    if (!result.success) {
      logger.warn('comfyui restart returned failure', { reason, error: result.error });
    } else {
      logger.info('comfyui restarted', { reason });
    }
  } catch (err) {
    logger.error('comfyui restart failed', {
      reason,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
