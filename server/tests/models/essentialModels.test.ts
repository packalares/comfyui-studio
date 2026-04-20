// Smoke tests for the essential-models batch orchestrator.
//
// We don't drive a real download here (the engine's HTTP path is covered
// elsewhere). These tests lock the public API surface + data shape.

import { describe, expect, it } from 'vitest';
import * as essential from '../../src/services/essentialModels/essentialModels.service.js';

describe('essentialModels.service', () => {
  it('listEssentialModels returns a non-empty list with required fields', () => {
    const list = essential.listEssentialModels();
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.name).toBe('string');
      expect(typeof m.dir).toBe('string');
      expect(typeof m.out).toBe('string');
      expect(typeof m.url.hf).toBe('string');
      expect(typeof m.url.mirror).toBe('string');
      expect(m.essential).toBe(true);
    }
  });

  it('every entry has unique id + out filename', () => {
    const list = essential.listEssentialModels();
    const ids = new Set<string>();
    const outs = new Set<string>();
    for (const m of list) {
      expect(ids.has(m.id), `duplicate id: ${m.id}`).toBe(false);
      expect(outs.has(m.out), `duplicate out: ${m.out}`).toBe(false);
      ids.add(m.id);
      outs.add(m.out);
    }
  });

  it('getInstallStatus returns a structured result', () => {
    const s = essential.getInstallStatus();
    expect(typeof s.installed).toBe('boolean');
    expect(typeof s.total).toBe('number');
    expect(typeof s.installedCount).toBe('number');
    expect(Array.isArray(s.models)).toBe(true);
    expect(s.models.length).toBe(s.total);
  });

  it('cancelBatch returns false for unknown task id', () => {
    expect(essential.cancelBatch('no-such-task')).toBe(false);
  });
});
