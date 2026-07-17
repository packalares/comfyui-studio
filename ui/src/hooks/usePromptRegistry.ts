// Singleton fetch of the prompt-token registry from the server.
//
// Returns a `Record<string, string[]>` mapping a token name like `business`
// to the list of options the PromptComposer chip surfaces when it sees
// `@business` in a template. Fetched once per session; the file is small
// and stable across a Studio run.
//
// Hook semantics: returns `null` until the fetch resolves, then the parsed
// registry object. Components should treat `null` like "empty registry" —
// `@foo` tokens will then be dropped at parse time (same as if the user
// hasn't defined any types yet), so first-render before fetch arrives is
// safe.

import { useEffect, useState } from 'react';

type Registry = Record<string, string[]>;

let cached: Registry | null = null;
let inflight: Promise<Registry> | null = null;
const subscribers = new Set<(r: Registry) => void>();

function fetchRegistry(): Promise<Registry> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch('/api/prompt-registry')
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => {
      const r = (data && typeof data === 'object' ? data : {}) as Registry;
      cached = r;
      subscribers.forEach((cb) => cb(r));
      return r;
    })
    .catch(() => {
      cached = {};
      subscribers.forEach((cb) => cb({}));
      return {};
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function usePromptRegistry(): Registry {
  const [registry, setRegistry] = useState<Registry>(() => cached ?? {});

  useEffect(() => {
    if (cached) {
      // Re-sync in case another caller fetched while this component was
      // mounting under React StrictMode's double-invocation.
      setRegistry(cached);
      return;
    }
    let alive = true;
    const onResolve = (r: Registry) => { if (alive) setRegistry(r); };
    subscribers.add(onResolve);
    fetchRegistry();
    return () => {
      alive = false;
      subscribers.delete(onResolve);
    };
  }, []);

  return registry;
}
