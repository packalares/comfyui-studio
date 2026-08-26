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
STUDIO_DEPS_MARKER=/root/.local/.studio-deps-installed-v3
if [ ! -f "$STUDIO_DEPS_MARKER" ]; then
  echo "[studio-deps] First-boot install starting…"
  mkdir -p /root/.local

  # ---- Cleanup of stale base-image/prior-install packages -----------------
  # Strip the base image's bundled xformers/flash_attn plus the three opencv-*
  # variants that share the cv2 namespace and overwrite each other (leaving
  # ximgproc empty, which kills LayerStyle's guidedFilter nodes). The rm globs
  # use `python3.*` rather than a hardcoded version so they survive the base's
  # Python — the v0.33 base is Python 3.13; older bases were 3.12.
  pip3 uninstall -y xformers torchao opencv-python opencv-python-headless \
                    opencv-contrib-python opencv-contrib-python-headless 2>/dev/null || true
  rm -rf /usr/local/lib64/python3.*/site-packages/xformers* \
         /usr/local/lib64/python3.*/site-packages/flash_attn* \
         /usr/local/lib64/python3.*/site-packages/cv2* \
         /usr/local/lib/python3.*/site-packages/xformers* \
         /usr/local/lib/python3.*/site-packages/flash_attn* \
         /usr/local/lib/python3.*/site-packages/cv2* 2>/dev/null || true

  # ---- Torch stack --------------------------------------------------------
  # The v0.33 base ALREADY ships torch 2.11.0+cu130 (CUDA 13, Blackwell sm_120)
  # with matching torchvision/torchaudio and bundled CUDA-13 runtime wheels, so
  # we deliberately DO NOT reinstall torch here. (Older bases shipped an
  # incompatible torch 2.8 that had to be replaced — this one is exactly what
  # we want.) Everything below installs --no-deps against this base torch.

  # ---- Prebuilt extension wheels (must match torch 2.11 + cu13.0 + cp313) --
  # nunchaku: SVDQuant 4-bit runtime, a HARD dependency of ComfyUI-nunchaku
  # (quantized FLUX / Qwen-Image nodes hard-fail without it). This dev wheel is
  # the only cu13/torch2.11/cp313/linux build published — swap to a stable
  # release once one ships.
  pip3 install --no-cache-dir --no-deps \
    https://github.com/nunchaku-ai/nunchaku/releases/download/v1.3.0dev20260213/nunchaku-1.3.0.dev20260213+cu13.0torch2.11-cp313-cp313-linux_x86_64.whl
  # flash-attn: NOT installed on this base — no prebuilt cu13/torch2.11/cp313/
  # linux wheel exists yet, and building from source takes 30+ min and OOMs.
  # It is only an OPTIONAL faster-attention backend: the nodes that use it
  # (KJNodes GGUF loaders, Florence2, seedvr2_videoupscaler) fall back to
  # sdpa/sage attention when absent. Re-add a wheel here once upstream ships
  # cu13torch2.11...cp313-linux.
  # xformers: abi3 wheel from PyTorch's cu130 index (cp39-abi3 → forward-
  # compatible on cp313). Provides memory-efficient attention for nodes that
  # request it.
  pip3 install --no-cache-dir xformers \
    --index-url https://download.pytorch.org/whl/cu130

  # ---- Custom-node deps (split runs to dodge pip resolver depth) ----------
  pip3 install --no-cache-dir \
    transformers==4.57.6 torchcrepe comfyui-manager packaging

  # protobuf: onnx's generated code requires runtime >= 6.31.1 (gencode 6.31.1).
  # Left unpinned, pip resolves this to 5.29.6, which makes `import insightface`
  # die with a protobuf VersionError and breaks InstantID / FaceAnalysis.
  # Nothing in the tree declares a protobuf constraint, so without an explicit
  # pin whether insightface works is pure luck.
  #
  # opencv: every constraint in the tree is a LOWER bound (albumentations
  # >=4.9.0.80, ultralytics >=4.6.0, SAM-2 >=4.7.0), so an unpinned install now
  # resolves to 5.0.x — a major version bump that would land silently on a
  # rebuild. Custom nodes call cv2 APIs directly without declaring versions, so
  # pin the 4.x line this deployment has actually been running.
  pip3 install --no-cache-dir \
    protobuf==7.35.1 \
    opencv-contrib-python==4.13.0.92 \
    opencv-python==4.11.0.86 \
    opencv-python-headless==4.11.0.86
  pip3 install --no-cache-dir \
    ml_dtypes==0.5.4 audio-separator
  # facenet-pytorch 2.6.0 hard-pins `torch<2.3.0`. With deps, pip resolves
  # that by downgrading our cu13.0 torch to 2.2.2+cu121. --no-deps installs
  # the package itself; it uses our existing torch at runtime.
  pip3 install --no-cache-dir --no-deps facenet-pytorch
  # ChatterBox TTS / Higgs Audio 2 engine packages — declared `torch` dep
  # conflicts with our cu13.0 install if resolved normally; --no-deps installs
  # the package and trusts the existing torch.
  pip3 install --no-cache-dir --no-deps \
    s3tokenizer==0.0.2 descript-audio-codec

  # ---- Custom-node Python deps missing on this base's Python --------------
  # The base's Python (3.13 on the v0.33 base) does NOT carry the deps that
  # custom nodes installed under the previous base's Python 3.12 — those live
  # in /root/.local/lib/python3.12 and are invisible to 3.13. natsort is
  # imported at ComfyUI startup by ComfyUI-Lora-Manager, so its absence crashes
  # the entire ComfyUI boot. Add others here as they surface at runtime.
  pip3 install --no-cache-dir natsort

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
  # ComfyUI-LTXVideo/pyramid_blending.py does
  #   `from kornia.geometry.transform.pyramid import (..., pad)`
  # but this base's kornia (0.8.3) removed `pad` from that module -> ImportError
  # aborts the ENTIRE LTXVideo node pack at load (all LTXV nodes vanish). kornia's
  # `pad` was only an alias for torch.nn.functional.pad, which the file already
  # imports as `F`. Drop the dead import symbol and route its two call sites
  # (`= pad(` on the padding helpers) through F.pad. Guarded on the stale import
  # line so it's a no-op once patched (idempotent across reboots/rebuilds).
  LTXV_PB=/root/ComfyUI/custom_nodes/ComfyUI-LTXVideo/pyramid_blending.py
  if [ -f "$LTXV_PB" ] && grep -qE '^[[:space:]]*pad,[[:space:]]*$' "$LTXV_PB"; then
    sed -i '/^[[:space:]]*pad,[[:space:]]*$/d' "$LTXV_PB"
    sed -i 's/= pad(/= F.pad(/g' "$LTXV_PB"
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

  # better-sqlite3 is a native addon pinned to the Node ABI. The hostPath
  # node_modules may have been built for a different Node major (the old base
  # shipped Node 24; the v0.33 base ships Node 20) → it then fails to load with
  # a NODE_MODULE_VERSION mismatch and the server crash-loops on every DB open.
  # Probe it and rebuild (fetches the matching prebuilt — no compiler needed)
  # only when it won't load.
  (cd /studio/server && node -e 'require("better-sqlite3")' 2>/dev/null) \
    || (cd /studio/server && echo "[studio] better-sqlite3 ABI mismatch — rebuilding for $(node -v)" && npm rebuild better-sqlite3)

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
