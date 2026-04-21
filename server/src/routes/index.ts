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
import templatesImport from './templates.import.js';
import templatesImportRemote from './templates.importRemote.js';
import templatesImportCivitai from './templates.importCivitai.js';
import templateWidgets from './templateWidgets.routes.js';
import generate from './generate.routes.js';
import dependencies from './dependencies.routes.js';
import models from './models.routes.js';
import comfyuiLifecycle from './comfyui.routes.js';
import comfyuiControl from './comfyui.control.routes.js';
import plugins from './plugins.routes.js';
import python from './python.routes.js';
import civitai from './civitai.routes.js';
import systemLauncher from './systemLauncher.routes.js';
import imgProxy from './imgProxy.routes.js';

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
router.use(templatesImport);  // /templates/import/* + /launcher/templates/import/*
router.use(templatesImportRemote); // /templates/import/{github,paste} aliases
router.use(templatesImportCivitai); // /templates/import/civitai (URL-based) + legacy /templates/import-civitai
router.use(templateWidgets);
router.use(generate);
router.use(dependencies);
router.use(models);           // local /models/* + /launcher/models/* aliases
router.use(comfyuiLifecycle); // local lifecycle + /launcher/... aliases
router.use(comfyuiControl);   // /comfyui/interrupt + /comfyui/queue/delete + /launcher/... aliases
router.use(plugins);          // local /plugins/* + /launcher/plugins/* aliases
router.use(python);           // local /python/* + /launcher/python/* aliases
router.use(civitai);          // local /civitai/* + /launcher/civitai/* aliases
router.use(systemLauncher);   // local /system/* + /launcher/system/* aliases
router.use(imgProxy);         // /img + /launcher/img — image proxy + md5 disk cache

export default router;
