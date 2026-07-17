// Tests for objectInfo cache invalidation on model lifecycle events (audit G2).
// Verifies that emitting model:installed / model:removed drops the cached
// object_info so the next getObjectInfo() call fetches fresh data from ComfyUI.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  env: { COMFYUI_URL: 'http://localhost:8188', NODE_ENV: 'test' },
  isProduction: false,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// events.js is NOT mocked — the real bus is used so the module-level
// subscriptions in objectInfo.ts fire correctly.
const bus = await import('../../src/lib/events.js');
const {
  getObjectInfo,
  seedObjectInfoCache,
  resetObjectInfoCache,
} = await import('../../src/services/workflow/objectInfo.js');

describe('objectInfo cache invalidation (audit G2)', () => {
  beforeEach(() => {
    resetObjectInfoCache();
  });

  it('seedObjectInfoCache warms the cache', async () => {
    const fixture = { TestNode: { input: {}, output: [] } };
    seedObjectInfoCache(fixture);
    const info = await getObjectInfo();
    expect(info).toBe(fixture);
  });

  it('emitting model:installed clears the cache', async () => {
    const fixture = { TestNode: { input: {}, output: [] } };
    seedObjectInfoCache(fixture);

    // Confirm cache is warm.
    expect(await getObjectInfo()).toBe(fixture);

    // Emit the lifecycle event.
    bus.emit('model:installed', { filename: 'some_model.safetensors' });

    // Cache should now be null. getObjectInfo will try to fetch from ComfyUI
    // (unreachable in test) and return {} — which is NOT the seeded fixture.
    const after = await getObjectInfo();
    expect(after).not.toBe(fixture);
  });

  it('emitting model:removed clears the cache', async () => {
    const fixture = { AnotherNode: { input: {} } };
    seedObjectInfoCache(fixture);

    bus.emit('model:removed', { filename: 'gone_model.safetensors' });

    const after = await getObjectInfo();
    expect(after).not.toBe(fixture);
  });
});
