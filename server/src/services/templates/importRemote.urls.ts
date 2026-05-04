// URL host allow-list + GitHub URL normalisation. Split out of
// `importRemote.ts` so the service file stays under the structure line cap.
//
// Decision tree (applied to the parsed URL):
//   - host not in HOST_ALLOW               -> reject with "Host not allowed"
//   - raw.githubusercontent.com            -> rawFile (verbatim)
//   - gist.githubusercontent.com           -> rawFile (verbatim)
//   - codeload.github.com                  -> rawFile (verbatim, zip tarballs)
//   - github.com/<o>/<r>/(blob|raw)/<ref>/<path>
//                                          -> rawFile via raw.githubusercontent.com
//   - github.com/<o>/<r>/tree/<ref>[/<dir>]
//                                          -> repoWalk
//   - github.com/<o>/<r>                   -> repoWalk (ref="" -> default branch)
//   - anything else                        -> reject

import { hostIsPrivate } from '../../lib/security.js';

export const HOST_ALLOW = new Set<string>([
  'github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
]);

export interface NormalisedUrl {
  kind: 'rawFile' | 'repoWalk';
  /** For rawFile kind. */
  rawUrl?: string;
  /** For repoWalk kind. */
  owner?: string;
  repo?: string;
  ref?: string;
  dir?: string;
}

/** github.com paths that point at a single file (blob or raw). */
const BLOB_RE = /^\/([^/]+)\/([^/]+)\/(blob|raw)\/([^/]+)\/(.+)$/;
/** github.com paths that point at a tree (directory) within a ref. */
const TREE_RE = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/;
/** github.com repo-root path (no sub-path). */
const REPO_RE = /^\/([^/]+)\/([^/]+)\/?$/;

export function assertAllowed(urlStr: string): URL {
  let parsed: URL;
  try { parsed = new URL(urlStr); }
  catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported scheme: ${parsed.protocol}`);
  }
  if (!HOST_ALLOW.has(parsed.hostname)) {
    throw new Error(`Host not allowed: ${parsed.hostname}`);
  }
  if (hostIsPrivate(parsed.toString())) {
    throw new Error('Host resolves to a private/loopback range');
  }
  return parsed;
}

export function normaliseGithubUrl(input: string): NormalisedUrl {
  const url = assertAllowed(input);
  if (url.hostname === 'raw.githubusercontent.com'
      || url.hostname === 'gist.githubusercontent.com'
      || url.hostname === 'codeload.github.com') {
    return { kind: 'rawFile', rawUrl: url.toString() };
  }
  if (url.hostname !== 'github.com') {
    throw new Error(`Host not allowed: ${url.hostname}`);
  }
  const blob = BLOB_RE.exec(url.pathname);
  if (blob) {
    const [, owner, repo, , ref, filePath] = blob;
    return {
      kind: 'rawFile',
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
    };
  }
  const tree = TREE_RE.exec(url.pathname);
  if (tree) {
    const [, owner, repo, ref, dir] = tree;
    return { kind: 'repoWalk', owner, repo, ref, dir: dir || '' };
  }
  const root = REPO_RE.exec(url.pathname);
  if (root) {
    const [, owner, repo] = root;
    return { kind: 'repoWalk', owner, repo, ref: '', dir: '' };
  }
  throw new Error(`Unrecognised GitHub URL shape: ${url.pathname}`);
}
