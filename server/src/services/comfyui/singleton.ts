// Shared ProcessService instance so the HTTP handlers + internal status
// poller see the same PID / start-time state. The singleton is lazy so tests
// that want isolation can replace it via `setProcessService(null)`.

import { ProcessService } from './process.service.js';
import { getDefaultLogService } from './log.service.js';

let instance: ProcessService | null = null;

export function getProcessService(): ProcessService {
  if (!instance) {
    instance = new ProcessService(getDefaultLogService());
    // Fire-and-forget initial detection so already-running ComfyUI is
    // reflected in status without needing an explicit /start call.
    void instance.checkIfComfyUIRunning();
  }
  return instance;
}

/** Test helper: swap the module-level instance (pass null to reset). */
export function setProcessService(svc: ProcessService | null): void {
  instance = svc;
}
