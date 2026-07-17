// Prompt-token registry routes.
//
// Single endpoint surfacing the user-editable JSON at
// `paths.promptRegistryFile`. The UI's PromptComposer fetches this once on
// app boot and uses it to expand `@business` style tokens into chip widgets
// with their registered option lists.

import { Router } from 'express';
import { loadPromptRegistry } from '../services/prompts/promptRegistry.js';

const router = Router();

router.get('/prompt-registry', (_req, res) => {
  res.json(loadPromptRegistry());
});

export default router;
