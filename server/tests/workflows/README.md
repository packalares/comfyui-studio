# Workflow fixtures

This directory holds raw workflow JSON snapshots used by regression tests for the
flatten / resolve / API-prompt conversion logic. They must be captured from a
live pod because ComfyUI serves them dynamically.

## Populate

Run these against a running ComfyUI (default URL shown — override
`COMFYUI_URL` as needed). Raw workflow JSON is served directly by ComfyUI
at `/templates/<name>.json`; the studio's old `/api/workflow/:name` proxy
was removed in the route cleanup.

```bash
COMFYUI_URL=http://localhost:8188

for name in \
    flux_schnell \
    flux_dev \
    image_wan2_2_14B_t2v \
    image_qwen_image_distill \
    hidream_i1_dev \
    sd3_5_medium_multi_resolution_image_gen ; do
  curl -sS "$COMFYUI_URL/templates/$name.json" \
    > "$name.json"
done
```

## Conventions

- One file per template, filename = template `name` (with `.json` extension).
- Do NOT commit fixtures containing PII or private prompts — these are meant to
  be the raw template JSON as served by ComfyUI.
- When a fixture changes, update the associated snapshot in `../snapshots/`
  and note the reason in the commit message.
