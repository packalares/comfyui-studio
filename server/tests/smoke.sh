#!/usr/bin/env bash
# Smoke test: curl every GET endpoint and snapshot the response.
# Idempotent. Runs offline — if STUDIO_URL is unreachable, each curl simply records the failure.
#
# Usage:
#   STUDIO_URL=http://localhost:3002 ./smoke.sh
#
# Writes JSON snapshots to ./snapshots/*.json alongside this script.

set -u

STUDIO_URL="${STUDIO_URL:-http://localhost:3002}"
TEMPLATE_NAME="${TEMPLATE_NAME:-flux_schnell}"
PROMPT_ID="${PROMPT_ID:-none}"
MODEL_NAME="${MODEL_NAME:-flux1-dev.safetensors}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAP_DIR="$HERE/snapshots"
mkdir -p "$SNAP_DIR"

snap() {
  local name="$1"
  local path="$2"
  local method="${3:-GET}"
  local out="$SNAP_DIR/${name}.json"
  # --fail-with-body exits non-zero on HTTP errors but still shows the body.
  # Swallow curl errors so the script continues to the next endpoint.
  curl -sS -X "$method" \
    -H 'Accept: application/json' \
    --max-time 10 \
    "${STUDIO_URL}${path}" \
    -o "$out" 2>"$SNAP_DIR/${name}.err" || true
  # Normalize empty body to a known marker instead of leaving a zero-byte file.
  if [ ! -s "$out" ]; then
    printf '{"_error":"empty or unreachable"}\n' > "$out"
  fi
}

# ---- GET endpoints (safe to hit repeatedly) ----
snap health                       /api/health
snap settings-api-key             /api/settings/api-key
snap settings-hf-token            /api/settings/hf-token
snap models-catalog               /api/models/catalog
snap system                       /api/system
snap templates                    /api/templates
snap workflow-settings            "/api/workflow-settings/${TEMPLATE_NAME}"
snap template-widgets             "/api/template-widgets/${TEMPLATE_NAME}"
snap history-single               "/api/history/${PROMPT_ID}"
snap gallery                      /api/gallery
snap models-download-history      /api/models/download-history
snap launch-options               /api/comfyui/launch-options
snap comfyui-logs                 /api/comfyui/logs

echo "Snapshots written to: $SNAP_DIR"
