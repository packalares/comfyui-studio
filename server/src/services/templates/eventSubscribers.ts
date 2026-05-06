// Wires the process-local event bus (`lib/events`) to the templates repo.
//
// Install + enable events recompute readiness against the live catalogs for
// the affected templates. Remove + disable events flip readiness straight to
// false (a template with any missing dep is not ready, so we short-circuit
// the catalog scan).
//
// Called once at boot from `server/src/index.ts`.

import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import { recomputeTemplateReadiness } from './dependencyCheck.js';

let wired = false;

export function wireTemplateEventHandlers(): void {
  if (wired) return;
  wired = true;
  subscribe();
}

/**
 * Test-only: force re-subscription after `bus.resetForTests()` wipes the
 * listener list. Production code must not call this — use the boot-time
 * `wireTemplateEventHandlers` instead.
 */
export function rewireForTests(): void {
  wired = true;
  subscribe();
}

function subscribe(): void {

  bus.on('model:installed', ({ filename }) => {
    void (async () => {
      try {
        const affected = templateRepo.findTemplatesRequiringModel(filename);
        if (affected.length > 0) await recomputeTemplateReadiness(affected);
      } catch (err) {
        logger.warn('model:installed hook failed', {
          filename, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  bus.on('model:removed', ({ filename }) => {
    try {
      const affected = templateRepo.findTemplatesRequiringModel(filename);
      if (affected.length > 0) {
        templateRepo.setInstalledForTemplates(affected, false);
      }
    } catch (err) {
      logger.warn('model:removed hook failed', {
        filename, error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bus.on('plugin:installed', ({ pluginId }) => {
    void (async () => {
      try {
        const affected = templateRepo.findTemplatesRequiringPlugin(pluginId);
        if (affected.length > 0) await recomputeTemplateReadiness(affected);
      } catch (err) {
        logger.warn('plugin:installed hook failed', {
          pluginId, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  bus.on('plugin:enabled', ({ pluginId }) => {
    void (async () => {
      try {
        const affected = templateRepo.findTemplatesRequiringPlugin(pluginId);
        if (affected.length > 0) await recomputeTemplateReadiness(affected);
      } catch (err) {
        logger.warn('plugin:enabled hook failed', {
          pluginId, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  bus.on('plugin:removed', ({ pluginId }) => {
    try {
      const affected = templateRepo.findTemplatesRequiringPlugin(pluginId);
      if (affected.length > 0) {
        templateRepo.setInstalledForTemplates(affected, false);
      }
    } catch (err) {
      logger.warn('plugin:removed hook failed', {
        pluginId, error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bus.on('plugin:disabled', ({ pluginId }) => {
    try {
      const affected = templateRepo.findTemplatesRequiringPlugin(pluginId);
      if (affected.length > 0) {
        templateRepo.setInstalledForTemplates(affected, false);
      }
    } catch (err) {
      logger.warn('plugin:disabled hook failed', {
        pluginId, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
