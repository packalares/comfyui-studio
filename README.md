# ComfyUI Studio

ComfyUI Studio is a web frontend plus backend that wraps ComfyUI — a node-graph
image / video / audio generation tool — behind a template-driven form UI, a
gallery of generations with full metadata and regenerate, a plugin manager
(via ComfyUI-Manager), a model catalog with local + CivitAI + HuggingFace
sources, and a polished import pipeline that can ingest workflows from
uploads, GitHub, paste, or a CivitAI model URL. It ships as a single
container deployed via Helm into an Olares (bitbot.ro) cluster.

## Layout

```
ui/                   # React + Vite + Tailwind frontend (self-contained)
server/               # Express + WebSocket + sqlite backend (self-contained)
docker/start.sh       # container entrypoint (prod vs dev branch)
Dockerfile            # multi-stage: frontend-build, studio-server-build, prod, dev
.github/workflows/    # GHCR build (prod + dev in parallel) on push to main
```

Helm chart is not in this repo. It lives in the sibling market repo (roughly
`../../market/charts/comfyuistudio-1.0.1.tgz`).

## Architecture

### server/ — Express + WebSocket backend

Self-contained: own `package.json`, `node_modules`, `tsconfig`, `vitest` suite
under `tests/`. TypeScript, ESM. Built with `tsc` for prod, run under
`tsx watch` in dev.

Responsibilities:

- Template listing, search, and import pipeline (upload / GitHub / paste /
  CivitAI URL) with a staging-then-commit flow.
- Gallery in sqlite (better-sqlite3), fed by a queue sentry that listens to
  ComfyUI's WS events and writes gallery rows directly from `executed`
  payloads, with a history-based reconcile on `execution_success`.
- Model catalog (local scan + CivitAI + HuggingFace), with resolvers for
  download URLs and an auto-upsert path for manual URL overrides.
- Plugin manager bridge to ComfyUI-Manager.
- Image proxy with sharp-based resize and md5 disk cache.
- Video thumbnail generation via ffmpeg with a disk cache.
- CivitAI / HuggingFace API proxies.
- Client WebSocket relay: reverse-connects to ComfyUI's WS on every client
  connect, forwards messages, and survives ComfyUI restarts with automatic
  retry. Also broadcasts download progress, gallery mutations, and a
  single debounced `launcher-status` poll.
- Spawns ComfyUI as a child process (stdio owned by the backend) and a
  reverse proxy on `COMFYUI_PROXY_PORT` so the native ComfyUI editor stays
  reachable across restarts.

Bootstraps in `server/src/index.ts`. Routes are composed in
`server/src/routes/index.ts` and mounted at `/api`. All env reads go
through `server/src/config/env.ts`.

### ui/ — React + Vite + Tailwind frontend

Self-contained: own `package.json`, `node_modules`, `tsconfig`. React 18 with
Vite 6 and TypeScript. Tailwind + shadcn primitives. Sonner for toasts.
Lazy-loaded routes via `react-router-dom`.

Routes (from `ui/src/App.tsx`):

- `/` — Dashboard
- `/explore` — template + CivitAI workflow browse
- `/studio` and `/studio/:templateName` — form-driven generation
- `/gallery` — generations with metadata and regenerate
- `/models` — model catalog with CivitAI browse
- `/plugins/*` — installed, history, python dependencies, python packages
- `/settings`

Shadcn UI primitives present under `ui/src/components/ui/`:
`alert-dialog`, `checkbox`, `select`, `slider`, `sonner`, `switch`, `tabs`,
`tooltip`. Shared app primitives: `AppModal`, `ConfirmDialog`,
`DynamicForm`, `RunningTaskCard`, `GalleryTile`, `ImportWorkflowModal`,
`ExposeWidgetsModal`.

### docker/start.sh — container entrypoint

- In prod mode: runs `node dist/index.js` from the compiled backend; the
  frontend is already a static bundle the backend serves.
- In dev mode (`STUDIO_MODE=dev`): probes for `node_modules/.bin/tsx` and
  `node_modules/.bin/vite`, reinstalls if missing, then spawns
  `tsx watch src/index.ts` (backend hot-reload) and
  `vite --host 0.0.0.0 --port 3001` (frontend HMR), tails both log files
  into container stdout, and exits on first child death so Kubernetes
  restarts the pod.

### Dockerfile — multi-stage

- `frontend-build` — `npm ci` + `npm run build` in `ui/`, throwaway.
- `studio-server-build` — installs `nodejs24-devel` (needed because
  `better-sqlite3` has no Node 24 prebuilds yet and compiles from source),
  `npm ci` + `tsc` + `npm prune --omit=dev` in `server/`.
- `prod` — final runtime. Copies compiled JS, pruned `node_modules`, and
  the static frontend bundle. Exposes 3002 and 8188.
- `dev` — source + full deps + `tsx` + `vite`. Expects `STUDIO_MODE=dev`
  and optionally a hostPath mount over `/studio` for live editing.

Base image: `docker.io/beclab/comfyui:v0.18.2-fe1.43.4-launcher0.2.36`.
Both final stages remove the base image's baked-in launcher
(`/app/server`, `/app/dist/spa`); the ComfyUI editor frontend itself stays.

### .github/workflows/build.yml

On push to `main` (and manual `workflow_dispatch`), builds `prod` and `dev`
image targets in parallel (matrix, `fail-fast: false`) and pushes them to
`ghcr.io/<owner>/<repo>` tagged with the short SHA and `latest`
(dev target adds a `-dev` suffix). GHA cache enabled per target. Provenance
and SBOM disabled to avoid the double `unknown/unknown` platform entry in
the registry UI.

## Key features

- Template-driven generation: a form UI generated from each workflow's
  exposed-widget bindings.
- Advanced Settings panel with a custom expose-widget picker.
- Gallery with full generation metadata per row: prompt, seed, model,
  sampler, steps, cfg, dimensions, and the originating workflow JSON.
- Regenerate from any gallery row, with an optional randomize-seed toggle.
- Cascade-delete: removing a gallery row also prunes ComfyUI's history for
  that prompt so it doesn't resurrect on the next Import.
- Explicit "Import from ComfyUI history" button — Studio never silently
  auto-mirrors ComfyUI's history.
- Four import sources for templates: upload (`.json` or `.zip`), GitHub URL
  (blob / tree / repo walk), paste JSON, CivitAI model URL.
- Staging pipeline with review: pick which workflows to commit; missing
  models are auto-resolved against the local catalog, MarkdownNote URLs
  inside the workflow, HF search, and CivitAI search. Commit is blocked
  if any required model is unresolved.
- CivitAI workflow feed on Explore: Latest / Hot / Search, cursor-based
  pagination where the API requires it.
- HuggingFace and CivitAI URL resolvers for model downloads, with catalog
  auto-upsert from manual URL overrides.
- Image proxy with sharp resize and md5 disk cache at
  `/root/ComfyUI/.cache/thumbs/`.
- Video thumbnail generation via ffmpeg, cached at
  `/root/ComfyUI/.cache/video-thumbs/`.
- Running-task card with live progress and a cancel button that proxies
  to `POST /api/comfyui/interrupt`.
- Plugin manager integration via ComfyUI-Manager endpoints (install,
  uninstall, enable, disable, switch version, history).
- Shared `AppModal` + `ConfirmDialog` primitives (Esc handling, backdrop
  dismiss, `aria-modal`, all unified).
- Sonner toast notifications on every async error path.
- `/api/view` reads media from disk first and only proxies ComfyUI as a
  fallback, so the gallery keeps rendering while ComfyUI is down or
  restarting.

## Getting started — development

### Prerequisites

- Docker for the container-based workflow.
- Either a ComfyUI reachable at `COMFYUI_URL`, or the Olares pod itself
  (which bundles ComfyUI).
- For standalone local work: Node 22+ (the Dockerfile targets Node 24 for
  `better-sqlite3`; locally anything recent enough for Vite 6 and
  `tsx@4` works).

### Option A — work against the deployed Olares pod (the actual workflow)

This is how the project is developed day-to-day. The Helm chart runs the
`dev` image with `STUDIO_MODE=dev` and a hostPath volume mounting this
repo at `/studio` inside the pod. When you save a file on the host, the
edit is instantly visible inside the container:

- `tsx watch` reloads the backend.
- `vite --host 0.0.0.0 --port 3001` HMRs the frontend.

See `docker/start.sh`:

```sh
(cd /studio/server && npx tsx watch src/index.ts             > /app/logs/studio.log 2>&1) &
(cd /studio/ui     && npx vite --host 0.0.0.0 --port 3001    > /app/logs/vite.log   2>&1) &
```

Nginx (outside this repo, part of the chart) routes `/` to vite on 3001
and `/api` + `/ws` to the backend on 3002.

### Option B — run the dev container locally

Point it at a ComfyUI reachable from your host:

```sh
docker buildx build --target dev -t comfyuistudio:dev .
docker run --rm -it \
  -p 3001:3001 -p 3002:3002 \
  -e STUDIO_MODE=dev \
  -e COMFYUI_URL=http://host.docker.internal:8188 \
  -v "$PWD":/studio \
  comfyuistudio:dev
```

Open `http://localhost:3001` for the UI (vite dev) and
`http://localhost:3002/api/health` for the backend.

### Option C — standalone host processes

Useful for quick backend-only or frontend-only iteration.

```sh
cd server && npm install && npm run dev     # tsx watch, needs COMFYUI_URL
cd ui     && npm install && npm run dev     # vite dev, needs a running backend
```

The backend listens on `BACKEND_PORT` (default 3002) and serves the static
frontend from `../dist` in prod; in dev you run vite separately on 3001.

### Environment variables

All env reads in the backend go through `server/src/config/env.ts`. The
full set, grouped:

Studio core:

- `NODE_ENV` — default `development`.
- `BACKEND_PORT` or `PORT` — HTTP port, default `3002`.
- `COMFYUI_URL` — default `http://localhost:8188`.
- `MODELS_DIR` — root of ComfyUI's model tree for disk-fallback stats.
- `MAX_CONCURRENT_DOWNLOADS` — default `2`.
- `UPLOAD_MAX_BYTES` — default 50 MiB.
- `CORS_ORIGIN`, `WS_ORIGIN` — comma-separated allow-lists. Unset =
  permissive.
- `LOG_LEVEL` — `error | warn | info | debug`, default `info`.
- `STUDIO_CATALOG_FILE`, `STUDIO_CONFIG_FILE`,
  `STUDIO_EXPOSED_WIDGETS_DIR`, `STUDIO_SQLITE_PATH` — runtime file
  paths, resolved in `config/paths.ts`.

ComfyUI + system integration:

- `COMFYUI_PATH` — default `/root/ComfyUI`.
- `COMFYUI_PORT` — default `8188`.
- `COMFYUI_PROXY_PORT` — reverse-proxy to ComfyUI, default `8190`
  (set `0` to disable).
- `COMFYUI_ENTRYPOINT` — default `/runner-scripts/entrypoint.sh`.
- `COMFYUI_START_RETRIES` — default 120 (5 s per retry).
- `COMFYUI_STOP_WAIT_MS` — default 2000.
- `PYTHON_PATH`, `PLUGIN_PATH`, `DATA_DIR`, `CACHE_DIR`, `NODE_LIST_PATH`,
  `MODEL_CACHE_PATH`, `PLUGIN_HISTORY_PATH` — various runtime paths.
- `HF_ENDPOINT`, `GITHUB_PROXY`, `PIP_INDEX_URL`,
  `PLUGIN_TRUSTED_HOSTS`, `PIP_ALLOW_PRIVATE_IP`,
  `SHARED_MODEL_HUB_PATH` (default `/mnt/olares-shared-model`).
- `CLI_ARGS` — extra ComfyUI CLI args.
- `OS_SYSTEM_SERVER`, `DESKTOP_API_URL`, `NODENAME`,
  `DOMAIN_COMFYUI_FOR_ADMIN`, `DOMAIN_LAUNCHER_FOR_ADMIN` —
  Olares system bridges.
- `RP_RETRY_ATTEMPTS`, `RP_RETRY_BASE_DELAY_MS`, `RP_RETRY_BACKOFF`,
  `RP_RETRY_MAX_DELAY_MS` — resource-pack retry policy.
- `CUDA_DEVICE_GPU_MODE_0`, `NVSHARE_MANAGED_MEMORY` — GPU share hints.

External APIs:

- `CIVITAI_API_BASE` — default `https://civitai.com/api/v1`.
- `CIVITAI_MAX_RESPONSE_BYTES` — default 10 MiB.
- `CIVITAI_TOKEN` — optional seed; persisted `settings.civitaiToken` wins.
- `GITHUB_TOKEN` — raises api.github.com rate limit on import-from-github.
- `HUGGINGFACE_TOKEN` — HEAD private / size-redirected HF files.
- `IMG_PROXY_ALLOWED_HOSTS` — comma-separated hostnames /
  leading-dot suffixes, same semantics as vite's `allowedHosts`.

Test-only: `STUDIO_AUTO_RESOLVE_SEARCH=1` re-enables the HF + CivitAI
search branches in the staging auto-resolve pass under `NODE_ENV=test`.

## Deployment

### Build an image locally

```sh
docker buildx build --target prod -t comfyuistudio:local .
docker buildx build --target dev  -t comfyuistudio:local-dev .
```

### CI / registry

Push to `main`. The `build` workflow pushes two images per run:

| Tag                                   | Target | Contents                                     | Use for            |
| ------------------------------------- | ------ | -------------------------------------------- | ------------------ |
| `ghcr.io/<owner>/<repo>:<sha>`        | prod   | Compiled JS + static frontend, no dev deps   | Production pods    |
| `ghcr.io/<owner>/<repo>:latest`       | prod   | Same, always newest                          | Production pods    |
| `ghcr.io/<owner>/<repo>:<sha>-dev`    | dev    | Source + full deps + tsx + vite + ffmpeg    | Hot-reload dev pods |
| `ghcr.io/<owner>/<repo>:latest-dev`   | dev    | Same, always newest                          | Hot-reload dev pods |

### Olares

The Helm chart lives in a sibling repo and is not tracked here. It deploys
the `comfyuistudio` pod and a `comfyuistudio-entrance` pod, mounts this
repo via hostPath at `/studio` (in dev mode) for live editing, and wires
nginx so `/` goes to vite on 3001 and `/api` / `/ws` go to the backend
on 3002. Rolling a new image is just flipping the tag the deployment
references; the pod restarts and picks up the new prod image.

## Ports

| Port | Service                                        |
| ---- | ---------------------------------------------- |
| 3001 | Vite dev server (dev mode only)                |
| 3002 | Studio backend + static frontend (prod mode)   |
| 8188 | ComfyUI HTTP                                   |
| 8190 | Studio reverse proxy to ComfyUI (configurable) |

## API surface

All routes mount under `/api`. Every group also exposes a legacy
`/api/launcher/...` alias used by the pre-cutover frontend.

### `health.routes` — health

- `GET /health` — liveness probe.

### `settings.routes` — persisted user tokens

- `PUT|DELETE /settings/api-key`
- `PUT|DELETE /settings/hf-token`
- `PUT|DELETE /settings/civitai-token`

### `catalog.routes` — model catalog

- `GET  /models/catalog` — merged local + shared-hub + essentials feed.
- `POST /models/catalog/refresh-size` — HEAD-based size refresh for a row.

### `system.routes` — aggregate state

- `GET /system` — versions, GPU mode, reachability.
- `GET /queue` — current ComfyUI queue.
- `GET /downloads` — active download snapshots.

### `view.routes` — media streaming

- `GET /view` — disk-first media read, ComfyUI fallback.

### `upload.routes` — image upload

- `POST /upload` — multipart, rate-limited.

### `history.routes` — ComfyUI history

- `GET /history`
- `GET /history/:promptId`

### `gallery.routes` + `gallery.thumbnail.routes`

- `GET /gallery`, `GET /gallery/:id` — paginated list + row detail.
- `DELETE /gallery` (bulk ids), `DELETE /gallery/:id` — cascade to
  ComfyUI history.
- `POST /gallery/import-from-comfyui` — one-shot pull from `/api/history`.
- `POST /gallery/:id/regenerate` — body `{ randomizeSeed?: boolean }`.
- `GET /gallery/thumbnail?filename=` — disk-cached ffmpeg video poster.

### `templates.routes` + `templateWidgets.routes`

- `GET  /templates` — search + list.
- `POST /templates/refresh` — re-scan workflow dir.
- `GET  /templates/:name` — detail.
- `GET  /template-asset/*` — co-located asset server.
- `POST /templates/import-civitai` — legacy direct import.
- `DELETE /templates/:name`
- `POST /templates/:name/install-missing-plugins`
- `GET  /workflow/:name` — raw workflow JSON.
- `GET  /workflow-settings/:templateName`
- `GET|PUT /template-widgets/:templateName` — exposed-widget records.

### `templates.import` — staging pipeline

- `POST /templates/import/upload` — multipart `.json` / `.zip`.
- `GET    /templates/import/staging/:id`
- `POST   /templates/import/staging/:id/commit`
- `POST   /templates/import/staging/:id/resolve-model`
- `DELETE /templates/import/staging/:id`

### `templates.importRemote`

- `POST /templates/import/github` — blob / tree / repo walk.
- `POST /templates/import/paste` — raw JSON body.

### `templates.importCivitai`

- `POST /templates/import/civitai` — by CivitAI model URL (new flow).

### `generate.routes`

- `POST /generate` — submit a workflow to ComfyUI; rate-limited.

### `dependencies.routes`

- `POST /check-dependencies` — detect missing models / plugins.

### `models.routes` — local models

- `GET  /models`
- `POST /models/scan`
- `POST /models/delete`
- `POST /models/cancel-download`
- `POST /models/install/:modelName`
- `GET  /models/progress/:id`
- `GET  /models/download-history`
- `POST /models/download-history/clear`
- `POST /models/download-history/delete`
- `POST /models/download-custom` — arbitrary URL, rate-limited.

### `comfyui.routes` + `comfyui.control.routes` — ComfyUI lifecycle

- `GET  /status`
- `POST /start`, `POST /stop`, `POST /restart`
- `GET  /comfyui/logs`
- `POST /comfyui/reset`, `GET /comfyui/reset-logs`
- `GET|PUT /comfyui/launch-options`
- `POST /comfyui/launch-options/reset`
- `POST /comfyui/interrupt`
- `POST /comfyui/queue/delete`

### `plugins.routes` — ComfyUI-Manager bridge

- `GET  /plugins` — installed list.
- `POST /plugins/install`, `POST /plugins/uninstall`
- `GET  /plugins/progress/:taskId`, `GET /plugins/logs/:taskId`
- `POST /plugins/disable`, `POST /plugins/enable`
- `GET  /plugins/refresh`
- `POST /plugins/install-custom`
- `POST /plugins/switch-version`
- `POST /plugins/update-cache`
- `GET  /plugins/history`, `POST /plugins/history/clear`,
  `POST /plugins/history/delete`

### `python.routes` — pip + plugin python deps

- `GET|POST /python/pip-source`
- `GET  /python/packages`
- `POST /python/packages/install`, `POST /python/packages/uninstall`
- `GET  /python/plugins/dependencies`
- `POST /python/plugins/fix-dependencies`

### `civitai.routes` — proxy to civitai.com

- `GET /civitai/models/by-url`
- `GET /civitai/models/search`
- `GET /civitai/models/latest`, `GET /civitai/models/hot`
- `GET /civitai/models/:id`
- `GET /civitai/download/models/:versionId`
- `GET /civitai/latest-workflows`, `GET /civitai/hot-workflows`,
  `GET /civitai/search-workflows`

### `systemLauncher.routes` — Olares system bridges

- `GET  /system/open-path`
- `GET  /system/files-base-path`
- `GET|POST /system/network-status`
- `GET  /system/network-config`
- `GET  /system/network-check-log/:id`
- `POST /system/pip-source`, `POST /system/huggingface-endpoint`
- `POST /system/github-proxy`
- `POST /system/plugin-trusted-hosts`
- `POST /system/pip-allow-private-ip`

### `imgProxy.routes` — image proxy

- `GET /img` — sharp resize + md5 disk cache against allow-listed hosts.

### WebSocket

- `GET /ws` — relays ComfyUI events to the browser and pushes Studio-side
  broadcasts: `launcher-status`, `queue`, `gallery`, `downloads-snapshot`,
  and download progress messages.

## Frontend surface

- `Dashboard.tsx` — health, GPU mode, running-task card, quick links.
- `Explore.tsx` — browse local templates and the CivitAI workflow feed
  (Latest / Hot / Search), with the import modal.
- `Studio.tsx` — form-driven generation: dynamic form from exposed
  widgets, advanced settings, model dropdowns, regenerate state.
- `Gallery.tsx` — paginated grid with detail modal, metadata panel,
  regenerate (with randomize seed), bulk + single cascade-delete,
  explicit "Import from ComfyUI history" button.
- `Models.tsx` — catalog with local + CivitAI sources, install from URL,
  HF + CivitAI resolvers.
- `Plugins.tsx` (nested `/installed`, `/history`, `/python/*`) —
  ComfyUI-Manager bridge: install / enable / disable / switch-version /
  history / python deps audit + fix.
- `Settings.tsx` — tokens, pip source, HF endpoint, GitHub proxy,
  trusted hosts, ComfyUI launch options.

## Development conventions

- No emojis in code or UI.
- Reuse shadcn primitives: `Checkbox`, `Tooltip`, `AlertDialog`, `Select`,
  `Tabs`, `Switch`, `Slider`, `Sonner`. Don't reinvent them.
- Modal consolidation: use `AppModal` and `ConfirmDialog`. Do not
  introduce new bespoke `fixed inset-0` overlays.
- Toasts: `import { toast } from 'sonner'`.
- Group related footer / header buttons with `btn-group`.
- Backend file cap: every `.ts` under `server/src/` stays under 250 lines.
  Enforced by `server/tests/structure.test.ts`.
- Env access discipline: every `process.env.*` read lives in
  `server/src/config/env.ts`. Enforced by the same structure suite.
- Filesystem writes via `server/src/lib/fs.ts` (`atomicWrite`,
  `safeResolve`).
- Subprocess calls via `server/src/lib/exec.ts` (argv-only) or
  `services/comfyui/process.spawn.ts`.
- Never log or echo secrets — `middleware/logging.ts` redacts bearer
  tokens, cookies, `apiKey`, `hfToken`, etc.
- Every modified backend feature should have at least one vitest test
  under `server/tests/`.
- No frontend vitest harness exists — skip UI tests.

## Testing

```sh
cd server
npm run test                # vitest run, baseline ~470 tests
./tests/smoke.sh            # HTTP smoke against a running backend
```

Known pre-existing failures at the time of writing, all traceable to the
semantics evolution of `INSERT ON CONFLICT ... COALESCE` replacing
`INSERT OR IGNORE`:

- `structure file size cap` — a couple of files slightly over 250 lines.
- `gallery.repo appendFromHistory duplicate-return`.
- `gallery.sentry` legacy timer-based tests.
- One test in `importCommit.block`.

These are not blockers for new work; fix opportunistically when touching
the affected modules.

## Contributing

- Open a PR against `main`. Branch naming is free-form.
- Commit messages: imperative, present tense, single-line summary first,
  wrapped paragraphs in the body explaining the why. No co-author lines.
- New backend features carry a vitest test. Keep files under the 250-line
  cap or the structure suite will fail.
- If you add an env variable, add it to `server/src/config/env.ts` and
  the table in this README.

## License

License: TBD — see repo owner.
