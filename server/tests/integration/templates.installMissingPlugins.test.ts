// Integration — verify `installMissingPluginsForTemplate` classifies
// template_plugins edges into queued / alreadyInstalled / unknown and only
// calls the plugin install service for the not-yet-installed repos.
//
// We mock the plugin catalog + install service so the test doesn't touch
// the git / pip pipeline.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../../src/lib/db/templates.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

const installCalls: string[] = [];

vi.mock('../../src/services/plugins/cache.js', () => ({
  getAllPlugins: () => [
    {
      id: 'pack-a',
      repository: 'https://github.com/alice/pack-a',
      github: 'https://github.com/alice/pack-a',
      installed: true,
      disabled: false,
      name: 'Pack A',
    },
    {
      id: 'pack-b',
      repository: 'https://github.com/bob/pack-b',
      github: 'https://github.com/bob/pack-b',
      installed: false,
      disabled: false,
      name: 'Pack B',
    },
    {
      id: 'pack-disabled',
      repository: 'https://github.com/x/pack-disabled',
      github: 'https://github.com/x/pack-disabled',
      installed: true,
      disabled: true,
      name: 'Pack Disabled',
    },
  ],
  // getInstalledPluginKeys: returns installed+non-disabled repos as keys.
  getInstalledPluginKeys: () => {
    const set = new Set(['pack-a', 'alice/pack-a']);
    return { set, byCanonical: set };
  },
  // isPluginInstalled delegates to the keys set; mock returns true only for pack-a.
  isPluginInstalled: (ref: string) => ref.toLowerCase().includes('pack-a') || ref.toLowerCase() === 'alice/pack-a',
}));

vi.mock('../../src/services/plugins/install.js', () => ({
  installPlugin: async (pluginId: string) => {
    installCalls.push(pluginId);
    return `task-${pluginId}`;
  },
}));

describe('installMissingPluginsForTemplate', () => {
  useFreshDb();

  beforeEach(() => {
    installCalls.length = 0;
  });

  it('splits edges into queued / alreadyInstalled / unknown', async () => {
    // Seed a template whose edges include:
    //   alice/pack-a   -> catalog installed=true (alreadyInstalled)
    //   bob/pack-b     -> catalog installed=false (queued)
    //   x/pack-disabled -> catalog installed=true + disabled=true (queued)
    //   nobody/ghost   -> not in catalog (unknown)
    repo.upsertTemplate(
      {
        name: 'tpl', displayName: 'Tpl', category: null,
        description: null, source: 'open', tags_json: '[]', installed: false,
      },
      {
        models: [],
        plugins: [
          'alice/pack-a',
          'bob/pack-b',
          'x/pack-disabled',
          'nobody/ghost',
        ],
      },
    );
    const mod = await import('../../src/services/templates/installMissingPlugins.js');
    const result = await mod.installMissingPluginsForTemplate('tpl');
    // pack-b is not installed; pack-disabled is installed-but-disabled -> both queue.
    const queuedIds = result.queued.map((q) => q.pluginId).sort();
    expect(queuedIds).toEqual(['pack-b', 'pack-disabled']);
    expect(result.alreadyInstalled).toEqual(['alice/pack-a']);
    expect(result.unknown).toEqual(['nobody/ghost']);
    // The install service was called for the queued entries (dedup-safe).
    expect(installCalls.sort()).toEqual(['pack-b', 'pack-disabled']);
  });

  it('throws when the template does not exist', async () => {
    const mod = await import('../../src/services/templates/installMissingPlugins.js');
    await expect(mod.installMissingPluginsForTemplate('missing'))
      .rejects.toThrow(/not found/i);
  });
});
