// Tiny process-local event bus.
//
// Keeps write-path services (models, plugins) decoupled from read-path
// consumers (templates repo, readiness recompute). Consumers subscribe here;
// service modules call `emit(...)` and do not import the consumers directly.
//
// Intentionally built on node:events so listeners survive hot-reload and the
// API stays narrow: `on('model:installed', fn)` / `emit('model:installed', p)`.

import { EventEmitter } from 'events';

export interface StudioEventPayloads {
  /**
   * `absPath` is the on-disk location the writer (download / hub-clone)
   * just produced. The model-index listener uses it to upsert a single row
   * without re-walking the whole tree. Optional for back-compat with emit
   * sites that legitimately don't know the path (rare; both downloaders DO
   * know it).
   */
  'model:installed':        { filename: string; absPath?: string };
  'model:removed':          { filename: string; absPath?: string };
  /** Emitted by the download path when a download terminates with an error. */
  'model:download-failed':  { filename: string; error: string };
  'plugin:installed':       { pluginId: string };
  'plugin:removed':         { pluginId: string };
  'plugin:disabled':        { pluginId: string };
  'plugin:enabled':         { pluginId: string };
}

export type StudioEventName = keyof StudioEventPayloads;

const bus = new EventEmitter();
// Keep the default max listener count generous so boot-time subscribers from
// many modules never trip node's dev-mode warning.
bus.setMaxListeners(50);

export function on<K extends StudioEventName>(
  name: K,
  handler: (payload: StudioEventPayloads[K]) => void,
): () => void {
  bus.on(name, handler);
  return () => bus.off(name, handler);
}

export function off<K extends StudioEventName>(
  name: K,
  handler: (payload: StudioEventPayloads[K]) => void,
): void {
  bus.off(name, handler);
}

export function emit<K extends StudioEventName>(
  name: K,
  payload: StudioEventPayloads[K],
): void {
  bus.emit(name, payload);
}

/** Test-only: wipe every registered listener. */
export function resetForTests(): void {
  bus.removeAllListeners();
}
