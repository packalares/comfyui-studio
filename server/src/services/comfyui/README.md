ComfyUI process + status + launch-options + reverse-proxy services.

- `process.service.ts` — spawn/start/stop/restart orchestration.
- `status.service.ts` — running / pid / uptime / versions / gpuMode report.
- `launchOptions.service.ts` — CLI_ARGS persistence, building, and reset.
- `log.service.ts` — stdout/stderr ring buffer.
- `proxy.service.ts` — optional reverse proxy on COMFYUI_PROXY_PORT.
- `version.service.ts` — installed ComfyUI + frontend version probe.
