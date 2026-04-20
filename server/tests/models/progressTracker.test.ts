// Unit tests for the per-task progress tracker.
//
// These assertions lock in the tracker's contract so downstream services
// (`downloadController.service`, `essentialModels.service`, `models.service`)
// can rely on the exact state transitions.

import { describe, expect, it, beforeEach } from 'vitest';
import * as tracker from '../../src/services/downloadController/progressTracker.js';

describe('progressTracker', () => {
  beforeEach(() => tracker.__resetForTests());

  it('createTask returns a fresh UUID with a default progress record', () => {
    const id = tracker.createTask();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const p = tracker.getTask(id);
    expect(p).toBeDefined();
    expect(p!.status).toBe('downloading');
    expect(p!.completed).toBe(false);
  });

  it('updateTask applies shallow merges', () => {
    const id = tracker.createTask();
    tracker.updateTask(id, { overallProgress: 42, completed: true });
    const p = tracker.getTask(id)!;
    expect(p.overallProgress).toBe(42);
    expect(p.completed).toBe(true);
  });

  it('deleteTask drops the entry and cleans model mapping', () => {
    const id = tracker.createTask();
    tracker.setModelMapping('foo', id);
    tracker.deleteTask(id);
    expect(tracker.hasTask(id)).toBe(false);
    expect(tracker.getModelTaskId('foo')).toBeUndefined();
  });

  it('abortTask marks canceled and returns true', () => {
    const id = tracker.createTask();
    expect(tracker.abortTask(id)).toBe(true);
    const p = tracker.getTask(id)!;
    expect(p.canceled).toBe(true);
    expect(p.status).toBe('error');
    expect(p.error).toBe('Download canceled');
  });

  it('abortTask returns false for unknown id', () => {
    expect(tracker.abortTask('does-not-exist')).toBe(false);
  });

  it('snapshot returns a defensive copy, not the live record', () => {
    const id = tracker.createTask();
    tracker.updateTask(id, { overallProgress: 50, currentModelIndex: 2 });
    const snap = tracker.snapshot(id)!;
    expect(snap.overallProgress).toBe(50);
    expect(snap.currentModelIndex).toBe(2);
    // mutating snap must not affect the tracker
    snap.overallProgress = 0;
    expect(tracker.getTask(id)!.overallProgress).toBe(50);
  });

  it('removeModelMappingByTaskId returns the model name removed', () => {
    const id = tracker.createTask();
    tracker.setModelMapping('flux.safetensors', id);
    expect(tracker.removeModelMappingByTaskId(id)).toBe('flux.safetensors');
    expect(tracker.getModelTaskId('flux.safetensors')).toBeUndefined();
  });
});
