// Unified download-URL collector used by every resource installer.
// Consolidates the 4 copies of `getAllDownloadUrls` the launcher shipped
// (model / workflow / custom installers + the pack-level reconciliation
// helper). Callers differ only in whether they want the MODEL-specific
// priority (primary source -> cdn -> alternative primary) or the simpler
// ordering (hf -> mirror -> cdn) used by workflow/custom resources.
//
// The `user-requested source` argument lets a caller ask hf or mirror as the
// primary; everything else is appended as fallback.

import type { ResourceUrl } from '../../contracts/resourcePacks.contract.js';
import * as liveSettings from '../systemLauncher/liveSettings.js';

export interface SourcedUrl {
  url: string;
  source: string;
}

/** Apply an HF endpoint override, same rewrite as models/download.service. */
export function processHfEndpoint(
  url: string,
  hfEndpoint: string = liveSettings.getHfEndpoint(),
): string {
  if (!hfEndpoint) return url;
  if (!url.includes('huggingface.co')) return url;
  return url.replace('huggingface.co/', hfEndpoint.replace(/^https?:\/\//, ''));
}

/** Ordered priority used by model installer: primary -> cdn -> alt primary. */
export function collectModelDownloadUrls(
  raw: string | ResourceUrl,
  userSource: string = 'hf',
): SourcedUrl[] {
  if (typeof raw === 'string') return [{ url: raw, source: 'default' }];
  const out: SourcedUrl[] = [];
  const primarySrc = userSource === 'mirror' ? 'mirror' : 'hf';
  const primaryUrl = userSource === 'mirror' ? raw.mirror : raw.hf;
  if (primaryUrl) out.push({ url: processHfEndpoint(primaryUrl), source: primarySrc });
  if (raw.cdn) out.push({ url: raw.cdn, source: 'cdn' });
  const altSrc = userSource === 'mirror' ? 'hf' : 'mirror';
  const altUrl = userSource === 'mirror' ? raw.hf : raw.mirror;
  if (altUrl && altUrl !== primaryUrl) out.push({ url: processHfEndpoint(altUrl), source: altSrc });
  return out;
}

/** Simpler ordering used by workflow + custom installers: hf -> mirror -> cdn. */
export function collectSimpleDownloadUrls(raw: string | ResourceUrl): SourcedUrl[] {
  if (typeof raw === 'string') return [{ url: raw, source: 'default' }];
  const out: SourcedUrl[] = [];
  if (raw.hf) out.push({ url: processHfEndpoint(raw.hf), source: 'hf' });
  if (raw.mirror) out.push({ url: raw.mirror, source: 'mirror' });
  if (raw.cdn) out.push({ url: raw.cdn, source: 'cdn' });
  return out;
}

/** Primary URL used for HEAD probes / reconciliation. */
export function getPrimaryUrl(raw: string | ResourceUrl | undefined): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  return raw.hf || raw.mirror || raw.cdn;
}
