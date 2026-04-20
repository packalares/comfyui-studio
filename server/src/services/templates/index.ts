// Barrel for the templates service split. Callers import this as
// `services/templates/index.js`; the module re-exports everything the old
// single-file templates.ts used to expose so router code stays unchanged.

export type { TemplateData, FormInputData } from './types.js';
export {
  loadTemplatesFromComfyUI,
  getTemplates,
  getTemplate,
} from './templates.service.js';
