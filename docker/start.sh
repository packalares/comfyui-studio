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

# First-boot install of Python runtime deps + per-node patches.
#
# /root/.local/ is the hostPath persistent volume. Anything pip installs there
# survives pod restarts but is invisible to Dockerfile RUN steps (the volume
# mounts AFTER the image's /root content). So all Python deps must be installed
# from here, not from the Dockerfile.
#
# Marker file bumps every time the install list materially changes — bumping
# forces re-run on the next pod start.
STUDIO_DEPS_MARKER=/root/.local/.studio-deps-installed-v2
if [ ! -f "$STUDIO_DEPS_MARKER" ]; then
  echo "[studio-deps] First-boot install starting…"
  mkdir -p /root/.local

  # ---- Cleanup of stale base-image/prior-install packages -----------------
  # Base image ships xformers 0.0.35 which expects torch.distributed.GroupName
  # (removed in torch 2.8). Plus prior CI builds may have left a torch-2.8
  # flash_attn .so at /usr/local/lib64 that ABI-mismatches with anything else.
  # Three opencv-* variants share the cv2 namespace and overwrite each other,
  # leaving ximgproc empty (kills LayerStyle's guidedFilter nodes).
  pip3 uninstall -y xformers torchao opencv-python opencv-python-headless \
                    opencv-contrib-python opencv-contrib-python-headless 2>/dev/null || true
  rm -rf /usr/local/lib64/python3.12/site-packages/xformers* \
         /usr/local/lib64/python3.12/site-packages/flash_attn* \
         /usr/local/lib64/python3.12/site-packages/cv2* \
         /usr/local/lib/python3.12/site-packages/xformers* \
         /usr/local/lib/python3.12/site-packages/flash_attn* \
         /usr/local/lib/python3.12/site-packages/cv2* 2>/dev/null || true
  # ---- Torch stack (cu128 for Blackwell sm_120) ---------------------------
  # WITH deps so the matching nvidia-cuda-runtime-cu12 12.8.x wheels come along
  # — torch loads its CUDA libs from those wheels, no host CUDA upgrade needed.
  pip3 install --no-cache-dir \
    torch==2.10.0+cu128 torchvision==0.25.0+cu128 torchaudio==2.10.0+cu128 \
    --index-url https://download.pytorch.org/whl/cu128

  # ---- Prebuilt extension wheels (must match torch 2.10 + cu12.8) ---------
  pip3 install --no-cache-dir --no-deps \
    https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.1/flash_attn-2.8.1+cu12torch2.10cxx11abiTRUE-cp312-cp312-linux_x86_64.whl
  pip3 install --no-cache-dir --no-deps \
    https://github.com/nunchaku-tech/nunchaku/releases/download/v1.2.1/nunchaku-1.2.1+cu12.8torch2.10-cp312-cp312-linux_x86_64.whl
  # xformers — abi3 wheel from PyTorch's cu128 index. 0.0.34 is the last
  # version that uses cp39-abi3 (forward-compatible on cp312); 0.0.35 is
  # py39-none and its CUDA kernels were built for cp310 → won't load here.
  pip3 install --no-cache-dir xformers==0.0.34 \
    --index-url https://download.pytorch.org/whl/cu128

  # ---- Custom-node deps (split runs to dodge pip resolver depth) ----------
  pip3 install --no-cache-dir \
    transformers==4.57.6 torchcrepe comfyui-manager opencv-contrib-python packaging
  pip3 install --no-cache-dir \
    ml_dtypes==0.5.4 audio-separator
  # facenet-pytorch 2.6.0 hard-pins `torch<2.3.0`. With deps, pip resolves
  # that by downgrading our cu128 torch to 2.2.2+cu121. --no-deps installs
  # the package itself; it uses our existing torch at runtime.
  pip3 install --no-cache-dir --no-deps facenet-pytorch
  # ChatterBox TTS / Higgs Audio 2 engine packages — declared `torch` dep
  # conflicts with our cu128 install if resolved normally; --no-deps installs
  # the package and trusts the existing torch.
  pip3 install --no-cache-dir --no-deps \
    s3tokenizer==0.0.2 descript-audio-codec

  # ---- Custom-node source patches (idempotent) ----------------------------
  # jags_audiotools ships `libs/_init_.py` (single underscores) — Python only
  # recognizes `__init__.py`. Without the rename the package never registers.
  JAGS=/root/ComfyUI/custom_nodes/comfyui_jags_audiotools/libs
  if [ -f "$JAGS/_init_.py" ] && [ ! -f "$JAGS/__init__.py" ]; then
    mv "$JAGS/_init_.py" "$JAGS/__init__.py"
  fi
  # InstantCharacter/pipeline.py uses Union/Optional/List without importing them.
  IC_PIPE=/root/ComfyUI/custom_nodes/ComfyUI-InstantCharacter/InstantCharacter/pipeline.py
  if [ -f "$IC_PIPE" ] && ! head -1 "$IC_PIPE" | grep -q "from typing"; then
    sed -i '1i from typing import Union, Optional, List, Dict, Any, Tuple' "$IC_PIPE"
  fi
  # WAS Node Suite warns about missing ffmpeg_bin_path; point it at the
  # system ffmpeg if the node is present.
  WAS_CFG=/root/ComfyUI/custom_nodes/was-node-suite-comfyui/was_suite_config.json
  if [ -f "$WAS_CFG" ]; then
    python3 -c "import json,sys; p='$WAS_CFG'; d=json.load(open(p)); d['ffmpeg_bin_path']='/usr/bin/ffmpeg'; json.dump(d,open(p,'w'),indent=2)" || true
  fi

  touch "$STUDIO_DEPS_MARKER"
  echo "[studio-deps] First-boot install done."
fi

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
