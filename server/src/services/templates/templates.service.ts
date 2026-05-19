// Template service — re-exports generateFormInputs for callers that still use
// the old `templates.service.ts` import path. The in-memory cache that used to
// live here has been replaced by a DB-first approach; all listing / lookup now
// goes through `templates.repo.listPaginated` / `templates.repo.getTemplate`.

export { generateFormInputs } from './templates.formInputs.js';
