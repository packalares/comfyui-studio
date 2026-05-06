// Router composition root. Mounted at `/api` in src/index.ts.
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
import thumbnail from './thumbnail.routes.js';
import chat from './chat.routes.js';
import chatAttachments from './chat.attachments.routes.js';
import chatModels from './chat.models.routes.js';
import mcp from './mcp.routes.js';
import mcpServers from './mcpServers.routes.js';
import { personalityRouter } from './personality.routes.js';
import { skillsRouter } from './skills.routes.js';
import { commandsRouter } from './commands.routes.js';

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
router.use(templatesImport);
router.use(templatesImportRemote);
router.use(templatesImportCivitai);
router.use(templateWidgets);
router.use(generate);
router.use(dependencies);
router.use(models);
router.use(comfyuiLifecycle);
router.use(comfyuiControl);
router.use(plugins);
router.use(python);
router.use(civitai);
router.use(systemLauncher);
router.use(thumbnail);
router.use(chat);
router.use(chatAttachments);
router.use(chatModels);
router.use('/mcp', mcp);          // /api/mcp — Studio's MCP server endpoint
router.use(mcpServers);            // /api/mcp/servers and /api/mcp/profiles
router.use(personalityRouter);
router.use(skillsRouter);
router.use(commandsRouter);

export default router;
