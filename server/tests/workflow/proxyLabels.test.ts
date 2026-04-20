// Proxy-label resolution tests.

import { describe, expect, it } from 'vitest';
import { resolveProxyLabels } from '../../src/services/workflow/proxyLabels.js';

describe('resolveProxyLabels', () => {
  it('follows a subgraph -10 link to the real target node title', () => {
    // Proxy entry with innerNodeId "-1" points via subgraph input "control"
    // through a -10 link at slot 0 to an inner KSampler node.
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'my_wrapper_type',
            nodes: [
              { id: 40, type: 'KSampler', title: 'Main Sampler', inputs: [
                { name: 'seed', link: 99, widget: { name: 'seed' } },
              ] },
            ],
            links: [
              { id: 99, origin_id: -10, origin_slot: 0, target_id: 40, target_slot: 0 },
            ],
            inputs: [{ name: 'control' }],
          },
        ],
      },
    };
    const wrapperNode = { type: 'my_wrapper_type', inputs: [], outputs: [] };
    const proxyWidgets = [['-1', 'control']];
    const labels = resolveProxyLabels(wrapperNode, proxyWidgets, workflow);
    // Should resolve to "Main Sampler · Seed" (node title + resolved
    // internal input name, title-cased).
    expect(labels[0]).toMatch(/Main Sampler.*Seed/);
  });

  it('uses an explicit subgraph input label when present', () => {
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'sg',
            nodes: [],
            links: [],
            inputs: [{ name: 'steps', label: 'Sampling Steps' }],
          },
        ],
      },
    };
    const wrapperNode = { type: 'sg', inputs: [], outputs: [] };
    const labels = resolveProxyLabels(wrapperNode, [['-1', 'steps']], workflow);
    expect(labels[0]).toBe('Sampling Steps');
  });

  it('uses the direct inner node title when innerNodeId is numeric', () => {
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'sg',
            nodes: [{ id: 3, type: 'Sampler', title: 'Custom Sampler' }],
            links: [],
            inputs: [],
          },
        ],
      },
    };
    const wrapperNode = { type: 'sg', inputs: [], outputs: [] };
    const labels = resolveProxyLabels(wrapperNode, [['3', 'cfg']], workflow);
    expect(labels[0]).toMatch(/Custom Sampler.*Cfg/);
  });
});
