// Per-task progress state for plugin installs.

import { describe, expect, it, beforeEach } from 'vitest';
import * as progress from '../../src/services/plugins/progress.service.js';

function reset(): void {
  for (const id of Object.keys(progress.getAllTasks())) progress.removeTask(id);
}

describe('plugins progress service', () => {
  beforeEach(() => reset());

  it('createTask + getTaskProgress round trips', () => {
    progress.createTask('t1', 'my-plugin', 'install');
    const p = progress.getTaskProgress('t1');
    expect(p).not.toBeNull();
    expect(p!.pluginId).toBe('my-plugin');
    expect(p!.type).toBe('install');
    expect(p!.progress).toBe(0);
    expect(p!.completed).toBe(false);
  });

  it('updateProgress sets percent + optional message', () => {
    progress.createTask('t2', 'plug', 'install');
    progress.updateProgress('t2', 42, 'cloning');
    const p = progress.getTaskProgress('t2')!;
    expect(p.progress).toBe(42);
    expect(p.message).toBe('cloning');
  });

  it('completeTask flips completed + normalizes progress', () => {
    progress.createTask('t3', 'plug', 'install');
    progress.completeTask('t3', true, 'done');
    expect(progress.getTaskProgress('t3')!.completed).toBe(true);
    expect(progress.getTaskProgress('t3')!.progress).toBe(100);
    progress.createTask('t4', 'plug', 'install');
    progress.completeTask('t4', false, 'error');
    expect(progress.getTaskProgress('t4')!.progress).toBe(0);
  });

  it('cleanupCompletedTasks removes finished tasks only', () => {
    progress.createTask('a', 'p', 'install');
    progress.createTask('b', 'p', 'uninstall');
    progress.completeTask('a');
    const cleaned = progress.cleanupCompletedTasks();
    expect(cleaned).toBe(1);
    expect(progress.taskExists('a')).toBe(false);
    expect(progress.taskExists('b')).toBe(true);
  });

  it('getTaskStats counts by state + type', () => {
    progress.createTask('i', 'p1', 'install');
    progress.createTask('u', 'p2', 'uninstall');
    progress.completeTask('i');
    const stats = progress.getTaskStats();
    expect(stats.total).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.byType.install).toBe(1);
    expect(stats.byType.uninstall).toBe(1);
  });

  it('returns null for unknown task', () => {
    expect(progress.getTaskProgress('nope')).toBeNull();
  });
});
