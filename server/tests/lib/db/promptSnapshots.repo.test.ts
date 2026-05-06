// Tests for promptSnapshots.repo — insert/get/delete/sweep + TTL boundary.

import { describe, expect, it } from 'vitest';
import * as snapshotsRepo from '../../../src/lib/db/promptSnapshots.repo.js';
import { getDb } from '../../../src/lib/db/connection.js';
import { useFreshDb } from './_helpers.js';

describe('promptSnapshots repo', () => {
  useFreshDb();

  it('insertSnapshot + getSnapshot round-trip', () => {
    snapshotsRepo.insertSnapshot({
      promptId: 'p1',
      apiPromptJson: '{"1":{"class_type":"KSampler"}}',
      templateName: 'flux-dev',
    });
    const snap = snapshotsRepo.getSnapshot('p1');
    expect(snap).not.toBeNull();
    expect(snap!.apiPromptJson).toBe('{"1":{"class_type":"KSampler"}}');
    expect(snap!.templateName).toBe('flux-dev');
    expect(snap!.createdAt).toBeGreaterThan(0);
  });

  it('getSnapshot returns null for unknown promptId', () => {
    expect(snapshotsRepo.getSnapshot('nope')).toBeNull();
  });

  it('deleteSnapshot removes the row and returns true', () => {
    snapshotsRepo.insertSnapshot({ promptId: 'p2', apiPromptJson: '{}' });
    expect(snapshotsRepo.deleteSnapshot('p2')).toBe(true);
    expect(snapshotsRepo.getSnapshot('p2')).toBeNull();
  });

  it('deleteSnapshot returns false for missing promptId', () => {
    expect(snapshotsRepo.deleteSnapshot('ghost')).toBe(false);
  });

  it('insertSnapshot is idempotent (OR REPLACE)', () => {
    snapshotsRepo.insertSnapshot({ promptId: 'p3', apiPromptJson: '{"v":1}' });
    snapshotsRepo.insertSnapshot({ promptId: 'p3', apiPromptJson: '{"v":2}' });
    const snap = snapshotsRepo.getSnapshot('p3');
    expect(snap!.apiPromptJson).toBe('{"v":2}');
  });

  it('sweepOldSnapshots deletes rows older than maxAgeMs', () => {
    const db = getDb();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    db.prepare(
      'INSERT INTO prompt_snapshots (promptId, apiPromptJson, templateName, createdAt) VALUES (?, ?, ?, ?)',
    ).run('old-p', '{}', null, oldTs);
    snapshotsRepo.insertSnapshot({ promptId: 'new-p', apiPromptJson: '{}' });

    const deleted = snapshotsRepo.sweepOldSnapshots(60 * 60 * 1000); // 1 hour TTL
    expect(deleted).toBe(1);
    expect(snapshotsRepo.getSnapshot('old-p')).toBeNull();
    expect(snapshotsRepo.getSnapshot('new-p')).not.toBeNull();
  });

  it('sweepOldSnapshots at exact boundary: row just before cutoff is deleted', () => {
    const db = getDb();
    const maxAgeMs = 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    db.prepare(
      'INSERT INTO prompt_snapshots (promptId, apiPromptJson, createdAt) VALUES (?, ?, ?)',
    ).run('boundary-p', '{}', cutoff - 1);
    const deleted = snapshotsRepo.sweepOldSnapshots(maxAgeMs);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(snapshotsRepo.getSnapshot('boundary-p')).toBeNull();
  });
});
