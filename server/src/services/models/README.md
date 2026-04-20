Local model catalog + scan + install + download services.

- `models.service.ts` — public facade called by `routes/models.routes.ts`.
- `info.service.ts` — in-memory catalog access (bundled JSON source).
- `install.service.ts` — disk scan, install-status refresh, delete.
- `download.service.ts` — URL validation + rewrites (HF mirror, GH proxy).
- `sharedModelHub.ts` — resolver for the shared-model-hub mount layout.
