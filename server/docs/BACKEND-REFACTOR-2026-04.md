# Backend Refactor 2026-04

Audit report for the phased restructure of `server/src/`. Runs across twelve
agents (A through L): the original structural phases (A-E), the launcher cutover
(F-K), and the final audit (L).

## Before vs After

| Metric                        | Before (pre-phase-0)       | After phase-11 (Agent E)       | Final (after Agent L)     |
|-------------------------------|----------------------------|--------------------------------|---------------------------|
| Total `.ts` files under src   | ~9 monolithic              | 60 focused                     | 141 focused               |
| Total LOC (src)               | ~5400                      | 5009                           | 13,425                    |
| Largest file                  | `src/routes/api.ts` ~1600+ | `src/services/catalog.ts` 244  | `essentialModels.data.ts` 234 |
| Files over 250 lines          | several                    | 0                              | 0                         |
| Functions over 50 lines       | many                       | 0 flagged                      | 4 flagged (soft)          |
| Vitest tests                  | 0                          | 76                             | 244 (33 files)            |
| Route files                   | 1 (api.ts)                 | 14 (`*.routes.ts`)             | 20 (`*.routes.ts`)        |
| Endpoints served locally      | partial                    | same as before                 | 93 / 93 (100%)            |
| Endpoints proxied to launcher | many                       | many                           | 0                         |
| `process.env.*` call sites    | scattered                  | 1 (`src/config/env.ts`)        | 1                         |
| Route-level error-detail leaks | 29                        | 0                              | 0                         |
| `LAUNCHER_URL` consumers      | several                    | 4                              | 0 (var removed)           |
| `launcher-backend` imports    | multiple                   | multiple                       | 0                         |
| Direct `child_process` sites  | scattered                  | scattered                      | 2 (allow-listed)          |
| Direct `console.*` sites      | many                       | many                           | 2 (logger + req-log)      |
| `: any` / `as any` count      | unknown                    | unknown                        | 0                         |
| CJK characters                | present                    | present                        | 0                         |
| Hardcoded private IPs / secrets | present                  | present                        | 0                         |

## What moved where

- **Agent A — bootstrap + middleware** (phases 0-2). Created `src/config/env.ts`
  and `src/config/paths.ts`, funneled every `process.env.*` read, extracted the
  `middleware/` folder: `errors.ts` (ApiError, errorHandler, asyncHandler),
  `logging.ts` (secret-redacting request logger), `rateLimit.ts` (in-memory
  per-IP window), `validate.ts` (experimental schema validator — see "What was
  deleted"). Wrote the initial health-route pilot as a template for Agent B.

- **Agent B — route extraction** (phases 3-5). Split the former monolithic
  `api.ts` into 14 route files, one per thematic group. Each file default-exports
  a Router, imports only from `services/` and `contracts/`, and is mounted from
  `src/routes/index.ts` in the order the launcher catch-all requires.

- **Agent C — service layer + workflow core** (phases 6-8). Introduced the
  `services/workflow/` subtree: `flatten/` (subgraph expansion), `prompt/`
  (UI-to-API conversion), `rawWidgets/` (widget enumeration + claim detection),
  `proxyLabels.ts`, `resolve.ts`, `collect.ts`, `objectInfo.ts`. Broke the
  catalog, templates, settings, downloads, exposedWidgets services out of the
  monolith. Removed the duplicate `getObjectInfo` in `services/comfyui.ts`.

- **Agent D — security hardening + contracts** (phases 9-10). Authored the
  `contracts/` folder (canonical JSON shapes). Added SSRF guard for
  `/launcher/models/download-custom`. Tightened the upload route's mimetype
  allow-list and extension deny-list. Wired `rateLimit` onto `/generate` and
  download-custom. Flagged the remaining 29 route-level catches as leaking
  `detail` in production (fixed in phase 11).

- **Agent E — polish + docs** (phase 11). Closed the detail-leak issue with a
  single `sendError` helper; deleted three dead files / exports; tightened
  `collectAllWorkflowNodes`; broke one import cycle in the flattener; added
  the structure compliance test; wrote this document and the server README.

## Launcher port (phases F-K)

Originally studio proxied most of its "model / plugin / python / civitai /
resource-pack / system / ComfyUI-lifecycle" traffic through an external
`launcher-backend` process. Phases F through K port every one of those 66
endpoints into studio itself.

- **Agent F — scaffolding.** Created `lib/exec.ts` (argv-only subprocess
  helper), `lib/download/` (resumable HTTP downloader with range/resume), the
  `services/models/sharedModelHub.ts` resolver, and the empty service
  subtrees the later agents filled. Introduced the ported env vars
  (`COMFYUI_PATH`, `DATA_DIR`, retry tuning, etc.) in `config/env.ts`.

- **Agent G — models + downloads.** Ported `/api/models/*` (list, scan,
  delete, install, progress, history, download-custom) and
  `/api/models/essential*` (batch install of the bundled SDXL+VAE+upscaler
  list). Introduced `services/downloadController/` — the shared queue /
  progress / broadcaster hookup used by models, essentialModels, and
  resourcePacks. Added SSRF guard on `download-custom` (literal hostname).

- **Agent H — ComfyUI lifecycle.** Ported `/status`, `/start`, `/stop`,
  `/restart`, `/comfyui/logs`, `/comfyui/reset`, `/comfyui/launch-options`,
  plus the reverse proxy on `COMFYUI_PROXY_PORT`. Swapped the status poller's
  data source in `src/index.ts` from an HTTP fetch of the launcher to the
  local `getLocalComfyUIStatus`. WS message type `launcher-status` kept
  because the frontend listens for it.

- **Agent I — plugins + python + civitai + resource-packs.** Ported the 24
  plugins endpoints (install, uninstall, enable/disable, switch-version,
  history, custom install with URL allow-list), 7 python endpoints (pip
  source, packages list/install/uninstall, plugin deps), 7 civitai endpoints
  (search, by-url, latest, hot, details, proxied download), and 5
  resource-pack endpoints (list, detail, install, progress, cancel).

- **Agent J — system controller.** Ported the 9 system endpoints
  (`network-status`, `network-config`, `pip-source`, `huggingface-endpoint`,
  `github-proxy`, `open-path`, `files-base-path`, check-log). Introduced
  `config/liveSettings.ts` — a mutable mirror of runtime-writable env vars
  (pip source, HF endpoint, GH proxy) so configurator writes take effect
  without process restart. Services now read through `liveSettings` instead
  of the frozen `env.*` constants for those specific keys.

- **Agent K — cutover.** Removed the legacy `/launcher/*` catch-all proxy
  router, the `proxyToLauncher` helper, the `LAUNCHER_URL` env var, and a
  dead `DOWNLOAD_CDN_URL` env var. Rewrote the remaining origin-citation
  comments so no `launcher-backend` reference survives under `src/`. All
  route files keep their dual-mount (`/<canonical>` + `/launcher/<same>`)
  so the frontend's pre-cutover calls continue to work.

- **Agent L — final audit.** Verified every invariant: tsc passes, 244
  tests pass across 33 files, no file >250 LOC, no `process.env` outside
  `config/env.ts`, no `launcher-backend` / `LAUNCHER_URL` / `launcherProxy`
  references in `src/`, no CJK, no hardcoded private IPs or sensitive
  strings, no `: any` / `as any`, `child_process` limited to two allow-listed
  files (`lib/exec.ts`, `services/comfyui/process.spawn.ts`), `console.*`
  limited to `lib/logger.ts` and `middleware/logging.ts`. Catalogued the
  final endpoint map (93 handlers; 67 dual-mounted; 26 studio-native) and
  the service tree. Updated this document and the README to reflect the
  final state. No refactor work performed.

### Cutover: files deleted in K

- `src/services/launcherProxy.ts` (27 LOC, zero callers).
- `src/routes/launcher.routes.ts` (56 LOC, catch-all proxy).
- Its mount from `src/routes/index.ts`.
- `LAUNCHER_URL` in `src/config/env.ts` + its consumers in `src/index.ts`.
- `DOWNLOAD_CDN_URL` in `src/config/env.ts` (zero consumers).

### Cutover: what stayed

- All `/launcher/<path>` dual-mount aliases across 20 route files.
- WS broadcast type `launcher-status` (frontend still listens).
- `services/systemLauncher/` service directory (different concern — system
  configurator — despite the name overlap with the old launcher process).

## What was deleted

During phases 6-11 the following were removed as dead or duplicate:

- `src/services/comfyui.ts :: getObjectInfo` (Agent C — duplicate of
  `services/workflow/objectInfo.ts`).
- `src/services/comfyui.ts :: uploadImage` (phase 11 — superseded by inline
  FormData in `src/routes/upload.routes.ts`).
- `src/lib/safetensors.ts` (phase 11 — whole file; no callers after the
  launcher took over safetensors verification).
- `src/lib/http.ts :: fetchWithRetry` + `FetchRetryOptions` (phase 11 — no
  callers; `getHfAuthHeaders` remains).
- `src/middleware/validate.ts` (phase 11 — never wired; if schema validation
  returns as a requirement, re-introduce with zod and a first real consumer).
- Various hand-rolled `detail: String(err)` response bodies (29 sites) —
  replaced with `sendError(res, err, status, message)`.

## Security changes (Agent D, locked in by phase 11)

| Rule | Enforced in | Guarded by test |
|------|-------------|-----------------|
| Non-production only: errors surface `detail` | `src/middleware/errors.ts` (`sendError` + `errorHandler`) | `tests/security/errors.test.ts` |
| Upload mimetype allow-list (image/audio/video) | `src/routes/upload.routes.ts::uploadRejectionReason` | `tests/security/upload.test.ts` |
| Upload extension deny-list (exe/bat/sh/js/html/svg) | same | same |
| Per-IP rate-limit on `/generate` + `/launcher/models/download-custom` | `src/middleware/rateLimit.ts` mounted in routes | `tests/security/rateLimit.test.ts` |
| SSRF — reject loopback / RFC1918 hosts on download-custom | `src/routes/models.routes.ts::hostIsPrivate` | `tests/security/ssrf.test.ts` |
| Path-traversal guard on fs writes | `src/lib/fs.ts::safeResolve` | `tests/security/safeResolve.test.ts` |
| Secret redaction in request log | `src/middleware/logging.ts::redactHeaders` + `redactBody` | `tests/security/logging.test.ts` |
| No `process.env` outside env.ts | structural | `tests/structure.test.ts` |
| No CJK, no private IPs, no sensitive strings | structural | `tests/structure.test.ts` |
| No import cycles | structural | `tests/structure.test.ts` |
| All files at most 250 lines | structural | `tests/structure.test.ts` |

## Correctness invariants locked in by tests

- **`liveSettings` swap** — services that used to read
  `env.PIP_INDEX_URL` / `env.HF_ENDPOINT` / `env.GITHUB_PROXY` directly now
  go through `config/liveSettings.ts`, so runtime configurator writes take
  effect without a restart. The original static `env.*` shape is preserved
  for everything else. (Agent J.)
- **URL allow-list for plugin custom install** — `plugins/install.service.ts`
  only clones from hosts on the trusted list (`github.com`, `gitlab.com`,
  `codeberg.org`, plus `PLUGIN_TRUSTED_HOSTS`). (Agent I.)
- **Argv-only subprocess contract** — every shell command flows through
  `lib/exec.run(command, argv[])`; no `exec`/`execSync` string invocation
  exists outside the two allowed files. Structural check in
  `tests/structure.test.ts`. (Agent F.)
- **Positive-only prompt injection** — user prompt lands only on non-negative
  nodes. `tests/workflow/prompt.test.ts`.
- **Phantom-value filtering** — widgets_values arrays ending with random
  random-mode markers don't trick the proxy-widget resolver.
  `tests/workflow/rawWidgets.test.ts`.
- **fs-stat fallback** — dependency check detects a model as installed even
  when the launcher's catalog lags behind a download-custom write.
  Covered by integration path in `tests/security/safeResolve.test.ts` and the
  behavior retained verbatim from Agent C's services/catalog + lib/fs.
- **Path-traversal on template assets** — `tests/security/safeResolve.test.ts`.
- **Proxy-label resolution** — `tests/workflow/proxyLabels.test.ts`.
- **Link resolution through pass-through nodes** — `tests/workflow/resolve.test.ts`.
- **Subgraph flattening** — `tests/workflow/flatten.test.ts`.
- **Upload rejection matrix** — `tests/security/upload.test.ts`.
- **Production error redaction** — `tests/security/errors.test.ts`.

## Known limitations still open

- **Rate limiter is in-memory and not cluster-safe.** If the server is ever
  run with multiple workers or behind a reverse proxy that load-balances, the
  per-IP window state is per-process. Fix: swap `Map<string, number[]>` for a
  Redis-backed counter. Not urgent — deployment today is single-process.

- **SSRF guard is literal-match.** `hostIsPrivate` runs regexes against the
  raw hostname; it does not perform DNS resolution. A DNS-rebinding attack or
  a hostname that resolves to RFC1918 at fetch time would bypass it. Mitigation
  would require resolving to A/AAAA records and checking each answer before
  allowing the fetch. Acceptable for the current trust model (the caller is
  always an authenticated browser session).

- **`launcher-backend/` directory still on disk but unreferenced.** Studio
  makes zero HTTP calls to it post-cutover. Keeping the directory around is
  convenient for historical reference but it can be deleted by ops at any
  time without affecting studio. A follow-up cleanup should remove it from
  the monorepo entirely.

- **URL allow-list for plugin install is a fixed literal set** plus the
  `PLUGIN_TRUSTED_HOSTS` extension env. No runtime UI to manage it; ops must
  redeploy to add a trusted host. Acceptable for current threat model.

- **Dead-code scan is grep-based, not typed.** `tests/structure.test.ts` does
  not detect unused exports. A future phase could add `ts-prune` or similar.

- **validate middleware was removed, not wired.** If the team wants
  structured request validation, add zod as a dependency and re-introduce a
  first schema on a mutating endpoint (e.g. `PUT /settings/api-key`).

- **Legacy mock `GET /models` endpoint still exists in models.routes.ts.**
  Returns a hardcoded list. Frontend no longer calls it; kept for
  backwards-compat with any external integration. Safe to delete in a later
  phase after confirming no third-party consumer remains.

## What did NOT change

- **The launcher backend.** `/home/laurs/packalares/apps/comfyui-studio/launcher-backend/` is
  outside the scope of this refactor and was not touched.
- **The frontend.** `/home/laurs/packalares/apps/comfyui-studio/src/` was not modified.
- **Any HTTP endpoint shape.** Every route keeps its path, method, status
  codes, and response body keys. The only observable change is that in
  `NODE_ENV=production` the `detail` field is absent on error responses — this
  was already the contract for `next(err)` paths via `errorHandler`; the
  phase-11 fix brings the 29 hand-rolled catches in line with it.
- **Any WS message shape.** `type`, `data`, and debouncing behavior are all
  preserved. Launcher-status polling interval (5s), queue debounce (100ms),
  and gallery debounce (500ms) are unchanged.
- **Any persisted file format.** The catalog JSON, settings JSON, and
  exposed-widgets JSON per template all use the same on-disk schema.

## Phase table

| Phase   | Focus                                           | Outcome                                       |
|---------|-------------------------------------------------|-----------------------------------------------|
| A (0-2) | env loader, middleware, health pilot            | single env site, `errorHandler`, `rateLimit`  |
| B (3-5) | route extraction                                | 14 route files, no more monolithic `api.ts`   |
| C (6-8) | service layer + workflow core                   | `services/workflow/*`, dup code removed       |
| D (9-10)| security hardening                              | SSRF, upload filters, secret redaction        |
| E (11)  | polish + docs                                   | `sendError`, structure.test.ts, README        |
| F       | launcher-port scaffolding                       | `lib/exec`, `lib/download`, shared hub        |
| G       | models + essential-models port                  | 15 endpoints local, download controller       |
| H       | ComfyUI lifecycle port                          | 10 endpoints local, reverse proxy             |
| I       | plugins / python / civitai / resource-packs     | 33 endpoints local, URL allow-list            |
| J       | system configurator + liveSettings              | 9 endpoints local, runtime env mirror         |
| K       | cutover                                         | `/launcher/*` catch-all + `LAUNCHER_URL` gone |
| L       | final audit                                     | invariants verified, docs finalized           |

## Endpoint inventory (final)

| Domain                 | File                          | Handlers | Dual-mounted |
|------------------------|-------------------------------|----------|--------------|
| health                 | health.routes.ts              | 1        | 0            |
| settings               | settings.routes.ts            | 6        | 0            |
| catalog                | catalog.routes.ts             | 2        | 0            |
| system (studio-native) | system.routes.ts              | 3        | 0            |
| view                   | view.routes.ts                | 1        | 0            |
| upload                 | upload.routes.ts              | 1        | 0            |
| history                | history.routes.ts             | 2        | 0            |
| gallery                | gallery.routes.ts             | 1        | 0            |
| templates              | templates.routes.ts           | 4        | 0            |
| template widgets       | templateWidgets.routes.ts     | 3        | 0            |
| generate               | generate.routes.ts            | 1        | 0            |
| dependencies           | dependencies.routes.ts        | 1        | 0            |
| models                 | models.routes.ts              | 10       | 10           |
| essential models       | essentialModels.routes.ts     | 5        | 5            |
| ComfyUI lifecycle      | comfyui.routes.ts             | 10       | 10           |
| plugins                | plugins.routes.ts             | 14       | 14           |
| python                 | python.routes.ts              | 7        | 7            |
| civitai                | civitai.routes.ts             | 7        | 7            |
| resource packs         | resourcePacks.routes.ts       | 5        | 5            |
| system (configurator)  | systemLauncher.routes.ts      | 9        | 9            |
| **total**              |                               | **93**   | **67**       |

Studio-native only (no `/launcher/` alias): 26 handlers across the first 12
rows. The remaining 67 are dual-mounted for frontend back-compat.

## Architecture (final)

```
server/src
├── index.ts                      # bootstrap, WS bridge, ComfyUI status poller
├── config/                       # env.ts, paths.ts, liveSettings (in services)
├── contracts/                    # JSON shape definitions (6 files)
├── lib/                          # pure helpers: fs, exec, http, logger, identity
│   └── download/                 # resumable HTTP downloader (engine, stream, ranges)
├── middleware/                   # errors, logging, rateLimit
├── routes/                       # 20 *.routes.ts files, composed in index.ts
└── services/                     # stateful modules
    ├── catalog*, templates/, settings, downloads, exposedWidgets, workflow/
    ├── comfyui/                  # process/status/launch-options/proxy/logs/version
    ├── models/                   # catalog, scan, install, download, sharedHub
    ├── plugins/                  # install/uninstall/switch/cache/history + toml
    ├── python/                   # pip + package + plugin deps
    ├── civitai/                  # models + workflows
    ├── resourcePacks/            # list/install + base/model/workflow/custom installers
    ├── systemLauncher/           # configurator + networkChecker/
    ├── essentialModels/          # data + batch service
    └── downloadController/       # queue, progress, history (shared)
```

## Invariants guarded by tests

| Invariant                                            | Test file                               |
|------------------------------------------------------|-----------------------------------------|
| Every `src/*.ts` ≤ 250 lines                         | tests/structure.test.ts                 |
| No `process.env` outside `src/config/env.ts`         | tests/structure.test.ts                 |
| No CJK characters in `src/` or `tests/`              | tests/structure.test.ts                 |
| No hardcoded private IPs in `src/`                   | tests/structure.test.ts                 |
| No `bitbot` / `olares` / `maharbig` / `packalyst@`   | tests/structure.test.ts                 |
| Module graph is a DAG (no import cycles)             | tests/structure.test.ts                 |
| Production error responses omit `detail`             | tests/security/errors.test.ts           |
| Upload allow-list + extension deny-list              | tests/security/upload.test.ts           |
| Rate-limit 429 after window                          | tests/security/rateLimit.test.ts        |
| SSRF: reject loopback/RFC1918/link-local hosts       | tests/security/ssrf.test.ts             |
| Path-traversal guard (`safeResolve`)                 | tests/security/safeResolve.test.ts      |
| Secret redaction in request log                      | tests/security/logging.test.ts          |
| Positive-only prompt injection                       | tests/workflow/prompt.test.ts           |
| Phantom-value filtering in widget enumeration        | tests/workflow/rawWidgets.test.ts       |
| Proxy-label resolution through subgraph              | tests/workflow/proxyLabels.test.ts      |
| Link resolution through pass-through / muted nodes   | tests/workflow/resolve.test.ts          |
| Subgraph flattening (wrappers, reroute, muted)       | tests/workflow/flatten.test.ts          |
| Dual-mount coverage on systemLauncher routes         | tests/system/routes.test.ts             |
| liveSettings swap (runtime env mirror)               | tests/system/liveSettings.test.ts       |
| Configurator write-through                           | tests/system/configurator.test.ts       |
| Network-check log cycling + parse                    | tests/system/networkChecker.test.ts     |
| System service reports                               | tests/system/systemService.test.ts      |
| Models install URL priority (hf/mirror/cdn)          | tests/models/install.urlSelection.test.ts + download.urlPriority.test.ts |
| Download controller: progress + cancel               | tests/models/downloadController.test.ts |
| Progress tracker lifecycle                           | tests/models/progressTracker.test.ts    |
| Essential batch progress                             | tests/models/essentialModels.test.ts    |
| Plugin install: URL allow-list + steps + TOML parse  | tests/plugins/install.test.ts + toml.test.ts |
| Plugin history + progress                            | tests/plugins/history.test.ts + progress.test.ts |
| Python requirement compatibility                     | tests/python/pip.test.ts                |
| Resource pack installer                              | tests/resourcePacks/installer.test.ts   |
| ComfyUI launch-options CLI build                     | tests/comfyui/launchOptions.test.ts     |
| ComfyUI log tail, status, process lifecycle          | tests/comfyui/{logTail,status,process}.test.ts |
| CivitAI validation                                   | tests/civitai/validation.test.ts        |

## Soft-exception: functions over 50 lines (4 total)

- `index.ts::wss.on('connection', ...)` (56 lines) — WS bridge wiring; splitting
  loses locality.
- `services/comfyui/htmlGenerator.ts::getNotRunningHtml` (57 lines) — inlined
  HTML template literal; the body is data, not logic.
- `services/resourcePacks/baseInstaller.ts::tryDownloadWithFallbacks` (52
  lines) — URL-by-URL fallback loop with cancel/cleanup.
- `services/templates/templates.service.ts::loadTemplatesFromComfyUI` (51
  lines) — `for..for` mapper over category / template trees.

None warrant a split.
