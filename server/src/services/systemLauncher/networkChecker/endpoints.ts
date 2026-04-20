// Host targets probed by the network checker. Each entry maps a service
// name (stable id used in the API response) to its default upstream URL
// and the override key in `liveSettings`. Defaults are generic public
// endpoints; the configurator can override each one per-deployment.

import * as liveSettings from '../liveSettings.js';

export type ServiceName = 'github' | 'pip' | 'huggingface';

export interface ServiceTarget {
  name: ServiceName;
  label: string;
  url: string;
}

/**
 * Build the current probe list. Reads `liveSettings` each call so edits
 * made via the configurator are picked up without a restart.
 */
export function buildTargets(): ServiceTarget[] {
  const githubProxy = liveSettings.getGithubProxy();
  const pipSource = liveSettings.getPipSource();
  const hfEndpoint = liveSettings.getHfEndpoint();
  return [
    {
      name: 'github',
      label: 'GitHub',
      url: normaliseGithubTarget(githubProxy) || 'https://github.com/',
    },
    {
      name: 'pip',
      label: 'pip',
      url: pipSource || 'https://pypi.org/simple/',
    },
    {
      name: 'huggingface',
      label: 'HuggingFace',
      url: hfEndpoint || 'https://huggingface.co/',
    },
  ];
}

/**
 * Strip paths off a GitHub proxy URL so we only probe the proxy host
 * itself. This matches launcher behaviour where operators commonly
 * configure a proxy URL that already includes a `/path` segment; probing
 * the full URL yields false negatives when the path template expects a
 * repo name.
 */
function normaliseGithubTarget(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return raw;
  }
}
