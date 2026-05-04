# Chat services

Services that drive Studio's chat experience: Ollama integration, context-window
management, suggestion generation, conversation lifecycle. This README is a
living map of what exists, what each piece does, and what's still on the
backlog.

## Files in this directory

| File | Role |
|---|---|
| `streamChat.ts` | Top-level streaming orchestrator. Wires repo + tools + ThinkParser + telemetry; emits `chat:start`/`chat:chunk`/`chat:reasoning`/`chat:tool`/`chat:done` over WS. |
| `ollamaStep.ts` | One Ollama `/api/chat` round-trip. Builds the request body, parses NDJSON deltas, extracts tool calls. |
| `ollamaChat.ts` | Wire types (`OllamaChatMessage`, `OllamaFinalFrame`), NDJSON iterator, telemetry summarizer. |
| `ollamaPs.ts` | `/api/ps` precheck — returns whether a given model is currently in VRAM. Drives the precise "Loading model into VRAM…" banner. |
| `ollamaLibrary.ts` | Ollama public-model catalog scrape + DB persistence (`ollama_library` table). Single seed scrape on cold start; manual refresh otherwise. |
| `ollamaTags.ts` | Per-model tag list scrape (`/library/<name>/tags`). Lazy, 1h cache. |
| `ollamaPull.ts` | Pull/cancel model downloads (`/api/pull`, `/api/delete`). |
| `ollamaTools.ts` | Studio-side tool registry → Ollama wire `tools` shape; tool-call extraction from frames. |
| `toolDispatch.ts` | The Ollama-step loop with tool-call dispatch. Bounded by `chatMaxToolSteps`. |
| `contextWindow.ts` | Per-conversation budget tracking. `computeUsage()` returns the meter payload (used / budget / strategy / numCtx / thinkMode / temperature / format). |
| `contextEnforce.ts` | Pre-send strategy hook. `sliding` filters the in-flight message list; `auto` runs a destructive Compact server-side. |
| `contextCompact.ts` | Manual `/compact` route + the `auto` strategy share `compactConversation()`. The auto path passes `preserveIds` so the just-appended user msg + assistant placeholder survive. `applySlidingWindow()` lives here too — non-destructive trim. |
| `autoTitle.ts` | Best-effort title generation on the first assistant turn. Skips conversations the user has already titled. |
| `suggestionGenerator.ts` | Post-turn dynamic follow-up suggestions. Fires after the main reply, ~50 tok JSON-array response, broadcast over WS. Toggleable. |
| `thinkParser.ts` | Streaming `<think>...</think>` splitter for legacy reasoning-tag models. New-format `message.thinking` is handled directly in `ollamaStep.ts`. |
| `prompts.ts` | Static system prompts: title, summary, tools doc. Single source of truth. |
| `broadcaster.ts` | Tiny WS-broadcaster wire. `index.ts` installs a sender; services call `emitChatEvent({...})`. |

## Per-conversation overrides (DB columns on `conversations`)

| Column | Type | UI control | Effect |
|---|---|---|---|
| `system_prompt` | TEXT, nullable | none yet | Prepended as `role: 'system'` on every request |
| `context_strategy` | `'sliding' \| 'auto'` | meter popover, radio cards | `sliding` = non-destructive trim of the outgoing request; `auto` = destructive Compact at threshold |
| `num_ctx` | INTEGER, nullable | meter popover, slider | `options.num_ctx` on every request |
| `think_mode` | `'on' \| 'off'`, nullable | meter popover, 3-pill toggle | `think: true \| false` top-level |
| `temperature` | REAL, nullable | meter popover, slider | `options.temperature` |
| `format` | `'json'`, nullable | meter popover, 2-pill toggle | top-level `format: 'json'` |

## Global settings (`settings.ts`)

Applied to every request unless a per-conversation override wins:

- `ollamaUrl`, `chatDefaultModel`, `chatKeepAlive` — basics
- `defaultContextStrategy` — initial value for new conversations
- `chatDefaultThinkMode` — initial value for new conversations
- `chatHighWaterPercent` — strategy trigger threshold
- `chatKeepRecent` — `sliding` keeps last N non-system turns at threshold
- `chatMaxToolSteps`, `chatLoadingHintMs`, `chatTitleTimeoutMs`, `chatSummaryTimeoutMs` — runtime guards
- `chatSmartSuggestions` — enables `suggestionGenerator.ts`

## Per-message telemetry (DB columns on `chat_messages`)

| Column | Source |
|---|---|
| `tokens_in`, `tokens_out` | Ollama final NDJSON frame (`prompt_eval_count`, `eval_count`) |
| `tokens_per_sec` | derived: `tokens_out / (eval_duration_ns / 1e9)` |
| `ms_to_first_token` | wall-clock between request POST and first non-empty delta |
| `ms_total` | wall-clock from request POST to stream close |
| `load_duration_ms` | Ollama final frame `load_duration` (ns → ms) |
| `model` | the model id sent on the request |

## WS events emitted

| Event | When |
|---|---|
| `chat:start` | request POSTed |
| `chat:chunk` | streaming `message.content` delta |
| `chat:reasoning` | streaming reasoning delta (legacy `<think>` tags or new `message.thinking`) |
| `chat:tool` | a tool call resolved |
| `chat:status` | `loading_model` (cold-load hint, fired by `/api/ps` precheck or 1.5s timer fallback); `compacting` (Auto strategy is running the destructive Compact) |
| `chat:done` | stream closed cleanly + telemetry attached |
| `chat:error` | upstream error |
| `chat:title` | auto-title resolved |
| `chat:suggestions` | post-turn suggestion generator finished |
| `chat:compacted` | manual `/compact` finished |

## Done in recent rounds

- Persisted Ollama library catalog + paginated UI (`ollama_library` table, `ollamaLibrary.ts` rewrite)
- Per-conversation `num_ctx` slider with `options.num_ctx` mirrored on every request
- Per-conversation `think_mode` toggle (`think: true|false`)
- Per-conversation `temperature` slider (`options.temperature`)
- Per-conversation `format: 'json'` toggle
- Smart suggestions with WS broadcast + Settings toggle
- `<think>` legacy + `message.thinking` new-format reasoning surface
- `/api/ps` precheck so the "Loading model into VRAM…" banner is precise instead of timer-driven
- `load_duration_ms` persisted + rendered in TelemetryFooter
- Settings → Default thinking mode (applied at conversation create)
- `chat:compacted` re-hydrate so the active thread updates after Compact-now
- Strategy redesign (v13): three strategies → two. `sliding` (non-destructive trim, keeps last N) and `auto` (destructive Compact at threshold). Manual Compact-now button stays. Old `'summarize'` rows migrate to `'auto'`; `'manual'` rows migrate to `'sliding'`.
- `num_ctx` Auto path stops sending `options.num_ctx` entirely — Ollama uses the model's native default (32K for glm-ocr, 4K for qwen3.5, etc). Meter reads the actual `context_length` from `/api/ps` and uses it as the budget, so the percentage reflects real allocation. `chatFallbackNumCtx` setting removed; vision models (glm-ocr) no longer break on Auto because Studio doesn't impose 4K below the vision tower's expected size.

## Backlog

### Power-user surface (gated behind a single textarea)

- **`conversations.advanced_options TEXT` (JSON)** — single column for sampling knobs that don't deserve their own UI: `seed`, `stop`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `repeat_last_n`, `mirostat`, `tfs_z`, `typical_p`. Server merges into `body.options` after the typed fields (so the slider for `temperature` still wins). Meter popover gets a collapsed "Advanced" textarea that JSON-validates on save.

### Hardware tuning (global, Settings → Chat → Advanced)

- `num_thread`, `num_gpu`, `num_batch` exposed as numeric inputs. These are properties of the Ollama server / machine, not a chat. Probably `chatHardwareOptions: { num_thread?, num_gpu?, num_batch? }` in `settings.ts`, merged into `body.options` after everything else.

### System prompt UI

- Textarea for `conversations.system_prompt`. The column already exists, the PATCH route already accepts it, the chat path already injects it as `role: 'system'`. Only the UI affordance is missing — likely a small "edit instructions" button next to the conversation title or under the meter popover.

### Cold-load banner improvement

- Currently `chat:status: loading_model` only emits the **code**, no duration estimate. After the first cold-load completes we have `load_duration_ms` for that model — we could cache it per-model and on the **next** cold-load show `"Loading qwen3.5:9b-q8_0 into VRAM (last load took 4.2 s)…"`. Would need a small in-memory map (model → last_load_ms) updated on every successful run.

### `format` JSON Schema

- Ollama 0.5+ accepts a JSON Schema object for `format` (not just the string `'json'`). Would let users say "always reply with `{title: string, body: string}`". Not in scope today; widening `conversations.format` from a `'json'`-only TEXT to a longer TEXT (storing the serialized schema) is the only DB change needed.

### Sidecar consistency for `autoTitle` / `summarizeText`

- Both fire one-shot `/api/chat` calls without `options.num_ctx`. After `suggestionGenerator` was fixed to mirror the main chat's `num_ctx`, these two are the remaining sidecars that can still cause Ollama KV-cache reloads between turns. Same fix shape: thread the conversation's `num_ctx` through. (`summarizeText` now fires both for the manual Compact-now button and the `auto` strategy, so the fix lands in two places at once.)

### Telemetry / observability

- Per-model **rolling load_duration histogram** in the Settings → Chat → Diagnostics view (none today). Useful for spotting models that are gradually getting slower as VRAM fragmentation builds.
- `/api/show` cache invalidation when a model is re-pulled. Currently the per-model cache has a 1h TTL — fine, but a manual "Refresh model info" button on the model picker would be a clean escape hatch.

### Multi-agent / system-prompt presets

- Already noted in user-level memory (`project_chat_system_prompts_todo.md`): infra for a presets table is in place; only the UI / CRUD round-trip is missing. When that lands, the per-conversation `system_prompt` column becomes the persisted choice from the preset list.

## Conventions

- **Best-effort sidecars** (`autoTitle`, `suggestionGenerator`, `compactConversation`) never throw upward. They `void`-fire from `streamChat.ts`, swallow errors with a `logger.warn`, and either emit a WS event on success or stay silent on failure. The UI must always have a static fallback for what the sidecar would have produced.
- **Schema bumps:** when adding a column to `conversations` or `chat_messages`, also add an idempotent `ALTER TABLE ADD COLUMN` migration in `lib/db/connection.ts`. Never rely on `CREATE TABLE IF NOT EXISTS` alone — that only fires on a brand-new DB.
- **Per-conversation override → typed column.** "I want it on a slider/toggle" → typed column. "I'll edit JSON for this once a year" → `advanced_options` JSON.
- **Telemetry** lives on `chat_messages`, not `conversations`. Each turn is its own row of timings.

