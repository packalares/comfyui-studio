#!/bin/bash
# ComfyUI Studio container entrypoint.
#
# - In prod (default) it runs pre-compiled JS from /studio/server/dist.
# - In dev (STUDIO_MODE=dev) it expects the source to be mounted into /studio
#   (and /studio/server), and runs tsx watch + vite dev.
#
# The studio backend spawns ComfyUI as a child process so stdio pipes are
# owned by the same tsx-watch tree that serves the API.
set -e
mkdir -p /app/logs

# ComfyUI's /root/ComfyUI/.git dir is surfaced with host-side ownership via the
# hostPath mount, so git refuses to operate ("dubious ownership"). Trust it so
# ComfyUI-Manager's Update flow (git fetch/checkout via the pod's git) works.
git config --global --add safe.directory /root/ComfyUI 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

if [ "${STUDIO_MODE}" = "dev" ]; then
  # Dev: the host mounts the source folders over these paths. A partial node_modules
  # (interrupted install) would pass `-d` but lack the .bin entries npx needs, so we
  # probe for the actual binary and re-run install if it's missing.
  (cd /studio/ui       && [ -x node_modules/.bin/vite ] || (rm -rf node_modules && npm install))
  (cd /studio/server   && [ -x node_modules/.bin/tsx  ] || (rm -rf node_modules && npm install --include=dev))

  (cd /studio/server   && npx tsx watch src/index.ts             > /app/logs/studio.log    2>&1) &
  (cd /studio/ui       && npx vite --host 0.0.0.0 --port 3001    > /app/logs/vite.log      2>&1) &
else
  # Prod: run the compiled code baked into the image.
  (cd /studio/server   && node dist/index.js    > /app/logs/studio.log    2>&1) &
  # Studio frontend is already static at /studio/dist — the studio backend serves it.
fi

# Stream everything into container stdout so `kubectl logs` shows it live.
tail -F /app/logs/*.log 2>/dev/null &

# If any supervised process dies, bail so Kubernetes restarts the pod.
wait -n
exit $?
