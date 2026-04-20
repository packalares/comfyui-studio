Bundled reference data for the ported launcher services.

Tracked (static, read-only):
- `all_nodes.mirrored.json` — plugin catalog snapshot used by Agent I's plugin service.
  Contains some CJK in plugin/author metadata (data content, preserved as-is).
- `model-list.json` — seed model catalog used by Agents G (models) and studio catalog.

Runtime-written (ignored via `.gitignore`):
- `model-cache.json` — mutable plugin-cache state.
- `download-history.json` — mutable download history for the downloadController.
- `.comfyui-manager-history.json` — plugin history (launcher naming preserved).

Overrides via `env.NODE_LIST_PATH`, `env.MODEL_CACHE_PATH`, and
`env.PLUGIN_HISTORY_PATH` (see `src/config/env.ts`).
