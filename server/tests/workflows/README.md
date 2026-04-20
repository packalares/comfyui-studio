# Workflow fixtures

This directory holds raw workflow JSON snapshots used by regression tests for the
flatten / resolve / API-prompt conversion logic. They must be captured from a
live pod because ComfyUI serves them dynamically.

## Populate

Run these against a running ComfyUI Studio pod (default URL shown — override
`STUDIO_URL` as needed):

```bash
STUDIO_URL=http://localhost:3002

for name in \
    flux_schnell \
    flux_dev \
    image_wan2_2_14B_t2v \
    image_qwen_image_distill \
    hidream_i1_dev \
    sd3_5_medium_multi_resolution_image_gen ; do
  curl -sS "$STUDIO_URL/api/workflow/$name" \
    > "$name.json"
done
```

## Conventions

- One file per template, filename = template `name` (with `.json` extension).
- Do NOT commit fixtures containing PII or private prompts — these are meant to
  be the raw template JSON as served by ComfyUI.
- When a fixture changes, update the associated snapshot in `../snapshots/`
  and note the reason in the commit message.
