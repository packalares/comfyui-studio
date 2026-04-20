# Environment variables consumed by `server/src/**`

Generated from `grep -rn "process.env" server/src` during Phase 0 of the
refactor. After Phase 1 every call site reads through `src/config/env.ts`
instead of `process.env.*`.

| Variable                        | Default                                                    | Read from                                             | Notes |
|---------------------------------|------------------------------------------------------------|-------------------------------------------------------|-------|
| `BACKEND_PORT`                  | —                                                          | `src/index.ts`                                        | Preferred over `PORT` when both are set |
| `PORT`                          | `3002`                                                     | `src/index.ts`                                        | Fallback for `BACKEND_PORT` |
| `COMFYUI_URL`                   | `http://localhost:8188`                                    | `src/services/comfyui.ts`, `src/services/catalog.ts`, `src/routes/api.ts` | Base URL of the upstream ComfyUI |
| ~~`LAUNCHER_URL`~~              | —                                                          | (removed in phase K)                                  | Launcher cutover complete; studio no longer proxies |
| `MODELS_DIR`                    | `''` (disabled)                                            | `src/services/catalog.ts`, `src/routes/api.ts`        | Root of ComfyUI model tree on disk, used for stat-fallback install detection |
| `MAX_CONCURRENT_DOWNLOADS`      | `2`                                                        | `src/services/downloads.ts`                           | Parallel download cap |
| `STUDIO_CATALOG_FILE`           | `~/.config/comfyui-studio/catalog.json`                    | `src/services/catalog.ts`                             | Path to the persisted model catalog |
| `STUDIO_CONFIG_FILE`            | `~/.config/comfyui-studio/config.json`                     | `src/services/settings.ts`                            | Path to persisted user settings (api key, hf token) |
| `STUDIO_EXPOSED_WIDGETS_DIR`    | `~/.config/comfyui-studio/exposed_widgets`                 | `src/services/exposedWidgets.ts`                      | Directory of per-template exposed-widget records |
| `NODE_ENV`                      | `development`                                              | (new) `src/middleware/errors.ts`                      | Used by error middleware to gate stack-trace leaks |

Any NEW env access must be added both to the table above and to the typed
`env` export in `src/config/env.ts` — the repo enforces this with the lint
rule: `grep -rn "process.env" server/src | grep -v env.ts` must be empty.
