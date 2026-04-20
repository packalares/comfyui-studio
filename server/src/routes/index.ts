// Router composition root. Mounted at `/api` in src/index.ts.
//
// Every `*.routes.ts` file dual-mounts the canonical path plus a legacy
// `/launcher/...` alias so the frontend's pre-cutover URLs keep working.
// Order matters only where handlers overlap; current layout has no overlaps.

import { Router } from 'express';
import health from './health.routes.js';
import settings from './settings.routes.js';
import catalog from './catalog.routes.js';
import system from './system.routes.js';
import view from './view.routes.js';
import upload from './upload.routes.js';
import history from './history.routes.js';
import gallery from './gallery.routes.js';
import templates from './templates.routes.js';
import templateWidgets from './templateWidgets.routes.js';
import generate from './generate.routes.js';
import dependencies from './dependencies.routes.js';
import models from './models.routes.js';
import essentialModels from './essentialModels.routes.js';
import comfyuiLifecycle from './comfyui.routes.js';
import plugins from './plugins.routes.js';
import python from './python.routes.js';
import civitai from './civitai.routes.js';
import resourcePacks from './resourcePacks.routes.js';
import systemLauncher from './systemLauncher.routes.js';

const router = Router();

router.use(health);
router.use(settings);
router.use(catalog);
router.use(system);
router.use(view);
router.use(upload);
router.use(history);
router.use(gallery);
router.use(templates);
router.use(templateWidgets);
router.use(generate);
router.use(dependencies);
router.use(models);           // local /models/* + /launcher/models/* aliases
router.use(essentialModels);  // local /models/essential* + /launcher/models/essential* aliases
router.use(comfyuiLifecycle); // local lifecycle + /launcher/... aliases
router.use(plugins);          // local /plugins/* + /launcher/plugins/* aliases
router.use(python);           // local /python/* + /launcher/python/* aliases
router.use(civitai);          // local /civitai/* + /launcher/civitai/* aliases
router.use(resourcePacks);    // local /resource-packs/* + /launcher/resource-packs/* aliases
router.use(systemLauncher);   // local /system/* + /launcher/system/* aliases

export default router;
