# ComfyUI Studio Server

Express + WebSocket backend for ComfyUI Studio. All HTTP endpoints live under
`/api`; WS upgrades hit `/ws`. Studio runs ComfyUI in-process — it does not
proxy to an external launcher.

## Layout

```
src/
  index.ts                     # app bootstrap, WS bridge, ComfyUI status poller
  config/
    env.ts                     # the ONLY place `process.env.*` is read
    paths.ts                   # resolved on-disk paths (catalog, config, widgets)
    liveSettings.ts            # mutable env mirror for runtime setters
  contracts/                   # shared JSON shapes
  lib/                         # pure helpers (fs, http, exec, identity, download)
    download/                  # resumable HTTP downloader
  middleware/                  # errors, logging, rateLimit
  routes/                      # one file per thematic group, each default-exports a Router
  services/                    # stateful modules
    catalog, templates, settings, downloads, exposedWidgets, workflow
    comfyui/                   # process/status/launch-options/proxy/version
    models/                    # catalog access, scan, install, download, sharedHub
    plugins/                   # install/uninstall/enable/disable/history/switchVersion
    python/                    # pip packages, plugin dep audit
    civitai/                   # model + workflow search + proxy
    resourcePacks/             # recipe installer
    systemLauncher/            # pip/HF/GH config writes, network checks, open-path
    essentialModels/           # bundled SDXL + VAE + upscalers batch install
    downloadController/        # shared download orchestrator (queue, progress)
    templates/                 # template loader + mutations
    workflow/                  # UI-to-API prompt conversion, flattening, widgets
tests/
  security/                    # rate limit, ssrf, upload, logging, errors hardening
  workflow/                    # flattener + prompt + proxy-label tests
  <per-service>/               # one folder per service subtree
  structure.test.ts            # file-size / env / CJK / IP / cycle guards
```

## Conventions

- **File size cap:** every `.ts` under `src/` is at most 250 lines.
- **Function size cap:** 50 lines per function; longer means split.
- **No Chinese characters** anywhere under `src/` or `tests/`.
- **No hardcoded private IPs, external domains, emails, or tokens.**
- **Env access funneled through `src/config/env.ts`.** Add new variables to
  both `env.ts` and the env table below.
- **Filesystem writes go through `src/lib/fs.ts`** (`atomicWrite`, `safeResolve`).
- **Subprocess invocations** only through `src/lib/exec.ts` (argv-only) or
  `services/comfyui/process.spawn.ts` (ComfyUI entrypoint).
- **Never log or echo secrets.** `src/middleware/logging.ts` redacts bearer
  tokens, cookies, `apiKey`, `hfToken`, etc.

## Adding a new endpoint

1. Pick or create a route file under `src/routes/<group>.routes.ts`.
2. Keep handlers thin — push stateful logic into `src/services/*`. Import
   contract types from `src/contracts/*`.
3. On internal errors, call `sendError(res, err, status, message)` from
   `src/middleware/errors.js`. It strips `detail` in production. For async
   handlers wrap with `asyncHandler` so thrown errors reach the handler.
4. Add a unit test under `tests/<domain>/<name>.test.ts`.
5. Mount the router from `src/routes/index.ts`.

## Running

```sh
npm install                    # once

npm run dev                    # dev, hot-reload via tsx watch
npm run build && npm start     # production

npm test                       # vitest suite (244 tests)
./tests/smoke.sh               # HTTP smoke
```

Studio spawns ComfyUI itself via `services/comfyui/process.service.ts` — the
entrypoint script (path from `COMFYUI_ENTRYPOINT`) with CLI args assembled
from `launchOptions.service.ts`. A reverse proxy on `COMFYUI_PROXY_PORT`
keeps the native ComfyUI frontend reachable across restarts.

## Legacy `/launcher/*` path aliases

67 of the 93 handlers are dual-mounted: the canonical path plus a
`/launcher/<same>` alias that serves the same local handler, so the
frontend's pre-cutover calls keep working. The remaining 26 are
studio-native (health, catalog, settings, system, view, upload, history,
gallery, templates, template-widgets, generate, check-dependencies, queue,
downloads). No generic catch-all exists — unknown `/launcher/...` paths 404.

Studio makes **zero HTTP calls to `launcher-backend`**. The `launcher-backend/`
directory is still on disk for historical reference but is not imported,
not contacted, and does not need to be running.

## Environment

| Variable                       | Default                                            | Purpose |
|--------------------------------|----------------------------------------------------|---------|
| `NODE_ENV`                     | `development`                                      | Gates error-detail leaks |
| `BACKEND_PORT`                 | —                                                  | Wins over `PORT` |
| `PORT`                         | `3002`                                             | Bind port |
| `COMFYUI_URL`                  | `http://localhost:8188`                            | Upstream ComfyUI HTTP |
| `COMFYUI_PORT`                 | `8188`                                             | ComfyUI's internal port |
| `COMFYUI_PROXY_PORT`           | `8190`                                             | Reverse proxy port (0 disables) |
| `COMFYUI_PATH`                 | `/root/ComfyUI`                                    | ComfyUI install root |
| `COMFYUI_ENTRYPOINT`           | `/runner-scripts/entrypoint.sh`                    | Runner script |
| `PYTHON_PATH`                  | `python3`                                          | Python interpreter |
| `MODELS_DIR`                   | empty                                              | Root of ComfyUI model tree |
| `DATA_DIR`                     | empty                                              | Mutable data/cache root |
| `MAX_CONCURRENT_DOWNLOADS`     | `2`                                                | Parallel download cap |
| `SHARED_MODEL_HUB_PATH`        | `/mnt/olares-shared-model`                         | Shared hub mount |
| `STUDIO_CATALOG_FILE`          | `~/.config/comfyui-studio/catalog.json`            | Model catalog |
| `STUDIO_CONFIG_FILE`           | `~/.config/comfyui-studio/config.json`             | API key + HF token |
| `STUDIO_EXPOSED_WIDGETS_DIR`   | `~/.config/comfyui-studio/exposed_widgets`         | Per-template widget JSON |
| `UPLOAD_MAX_BYTES`             | `50 MiB`                                           | Multipart upload cap |
| `CORS_ORIGIN`                  | permissive                                         | Comma-separated allow-list |
| `WS_ORIGIN`                    | permissive                                         | WS Origin allow-list |
| `LOG_LEVEL`                    | `info`                                             | error / warn / info / debug |
| `HF_ENDPOINT` `GITHUB_PROXY` `PIP_INDEX_URL` | empty                              | Mirror / proxy prefixes |
| `CIVITAI_API_BASE`             | `https://civitai.com/api/v1`                       | CivitAI endpoint |

See `src/config/env.ts` for the full set (system-bridge, retry policy,
resource-pack retries, CLI defaults, etc.).

## Testing

`npm test` runs the full vitest suite (244 tests across 33 files, ~1.3s).
Key directories: `tests/security/`, `tests/workflow/`, `tests/<service>/`,
`tests/structure.test.ts` (structural invariants — file-size cap, env
discipline, CJK guard, private-IP guard, sensitive-string guard, and
DAG/no-circular-imports).

`./tests/smoke.sh` hits the HTTP surface against a running server.

## Refactor history

See `docs/BACKEND-REFACTOR-2026-04.md` for the phase-by-phase audit of the
restructure (agents A-L): endpoint inventory, before/after numbers, locked-in
invariants, and known limitations.
