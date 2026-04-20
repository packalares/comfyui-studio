// Base installer + URL collection + progress manager tests.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  collectModelDownloadUrls, collectSimpleDownloadUrls, getPrimaryUrl,
} from '../../src/services/resourcePacks/downloadUrls.js';
import * as pm from '../../src/services/resourcePacks/progressManager.js';
import {
  InstallStatus, ResourceType, type ResourcePack,
} from '../../src/contracts/resourcePacks.contract.js';

describe('downloadUrls collectModelDownloadUrls', () => {
  it('string url yields single entry', () => {
    const r = collectModelDownloadUrls('https://hf/x', 'hf');
    expect(r).toEqual([{ url: 'https://hf/x', source: 'default' }]);
  });

  it('prioritizes hf then cdn then mirror when source=hf', () => {
    const r = collectModelDownloadUrls({ hf: 'https://hf/a', mirror: 'https://m/a', cdn: 'https://cdn/a' }, 'hf');
    expect(r.map((x) => x.source)).toEqual(['hf', 'cdn', 'mirror']);
  });

  it('prioritizes mirror when source=mirror', () => {
    const r = collectModelDownloadUrls({ hf: 'https://hf/a', mirror: 'https://m/a', cdn: 'https://cdn/a' }, 'mirror');
    expect(r[0].source).toBe('mirror');
    expect(r.some((x) => x.source === 'hf')).toBe(true);
    expect(r.some((x) => x.source === 'cdn')).toBe(true);
  });

  it('skips missing sources', () => {
    const r = collectModelDownloadUrls({ hf: 'https://hf/a' }, 'hf');
    expect(r).toEqual([{ url: 'https://hf/a', source: 'hf' }]);
  });
});

describe('downloadUrls collectSimpleDownloadUrls', () => {
  it('emits in hf -> mirror -> cdn order', () => {
    const r = collectSimpleDownloadUrls({ hf: 'h', mirror: 'm', cdn: 'c' });
    expect(r.map((x) => x.source)).toEqual(['hf', 'mirror', 'cdn']);
  });

  it('passes through string url', () => {
    expect(collectSimpleDownloadUrls('https://x/y')[0].source).toBe('default');
  });
});

describe('downloadUrls getPrimaryUrl', () => {
  it('prefers hf first', () => {
    expect(getPrimaryUrl({ hf: 'a', mirror: 'b', cdn: 'c' })).toBe('a');
    expect(getPrimaryUrl({ mirror: 'b', cdn: 'c' })).toBe('b');
    expect(getPrimaryUrl(undefined)).toBeUndefined();
  });
});

const samplePack = (): ResourcePack => ({
  id: 'pack1',
  name: 'Pack 1',
  resources: [
    { id: 'r1', name: 'model', type: ResourceType.MODEL, url: 'https://hf/x', dir: 'a', out: 'b' },
    { id: 'r2', name: 'wf', type: ResourceType.WORKFLOW, url: 'https://hf/y', filename: 'y.json' },
  ],
});

describe('resourcePacks progressManager', () => {
  beforeEach(() => { /* state is in-module; reset by creating fresh task id */ });

  it('createProgress + getProgress round trips', () => {
    const p = pm.createProgress(samplePack(), 't1');
    expect(p.packId).toBe('pack1');
    expect(p.resourceStatuses.length).toBe(2);
    expect(pm.getProgress('t1')).toBe(p);
  });

  it('updateResourceStatus recomputes overall progress', () => {
    pm.createProgress(samplePack(), 't2');
    pm.updateResourceStatus('t2', 'r1', InstallStatus.DOWNLOADING, 50);
    pm.updateResourceStatus('t2', 'r2', InstallStatus.DOWNLOADING, 50);
    const p = pm.getProgress('t2')!;
    expect(p.progress).toBe(50);
  });

  it('cancelTask marks status + unfinished resources', () => {
    pm.createProgress(samplePack(), 't3');
    pm.updateResourceStatus('t3', 'r1', InstallStatus.COMPLETED, 100);
    pm.cancelTask('t3');
    const p = pm.getProgress('t3')!;
    expect(p.canceled).toBe(true);
    expect(p.status).toBe(InstallStatus.CANCELED);
    const r1 = p.resourceStatuses.find((r) => r.resourceId === 'r1')!;
    const r2 = p.resourceStatuses.find((r) => r.resourceId === 'r2')!;
    expect(r1.status).toBe(InstallStatus.COMPLETED); // unchanged
    expect(r2.status).toBe(InstallStatus.CANCELED);
  });

  it('hasActiveTask reports true only during DOWNLOADING/INSTALLING', () => {
    pm.createProgress(samplePack(), 't4');
    expect(pm.hasActiveTask('t4')).toBe(false); // PENDING
    pm.updateTaskStatus('t4', InstallStatus.DOWNLOADING);
    expect(pm.hasActiveTask('t4')).toBe(true);
    pm.updateTaskStatus('t4', InstallStatus.COMPLETED);
    expect(pm.hasActiveTask('t4')).toBe(false);
  });
});
