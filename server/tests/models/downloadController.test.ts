// Public-API smoke for the download controller orchestrator.

import { describe, expect, it, beforeEach } from 'vitest';
import * as ctrl from '../../src/services/downloadController/downloadController.service.js';
import * as tracker from '../../src/services/downloadController/progressTracker.js';

describe('downloadController.service', () => {
  beforeEach(() => tracker.__resetForTests());

  it('createDownloadTask returns a tracked id', () => {
    const id = ctrl.createDownloadTask();
    expect(ctrl.hasTask(id)).toBe(true);
    expect(ctrl.getTaskProgress(id)).toBeDefined();
  });

  it('updateTaskProgress applies updates', () => {
    const id = ctrl.createDownloadTask();
    ctrl.updateTaskProgress(id, { overallProgress: 25 });
    expect(ctrl.getTaskProgress(id)!.overallProgress).toBe(25);
  });

  it('cancelTask returns true for a known id and false otherwise', () => {
    const id = ctrl.createDownloadTask();
    expect(ctrl.cancelTask(id)).toBe(true);
    expect(ctrl.cancelTask('no-such-id')).toBe(false);
  });

  it('setProgressListener wires updates; null unwires', () => {
    const id = ctrl.createDownloadTask();
    const calls: string[] = [];
    ctrl.setProgressListener((taskId) => { calls.push(taskId); });
    ctrl.updateTaskProgress(id, { overallProgress: 50 });
    expect(calls).toContain(id);
    ctrl.setProgressListener(null);
    const before = calls.length;
    ctrl.updateTaskProgress(id, { overallProgress: 75 });
    expect(calls.length).toBe(before);
  });
});
