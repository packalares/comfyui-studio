# syntax=docker/dockerfile:1.6
#
# ComfyUI Studio — extends the upstream beclab image with our backend + UI.
#
# Two final targets:
#   prod (default) — compiled JS, runtime deps only, static frontend bundle. Small & fast.
#   dev            — source + dev deps included, ready for tsx watch + vite --host.
#
# Pick which to build with `--target prod` or `--target dev`.

ARG BASE_IMAGE=docker.io/beclab/comfyui:v0.24.0

# ======================================================================
# Stage: frontend-build — throwaway; we only need its dist/.
# ======================================================================
FROM ${BASE_IMAGE} AS frontend-build
WORKDIR /build/studio/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --include=dev
COPY ui/ ./
RUN npm run build


# ======================================================================
# Stage: studio-server-build — compile TS → dist, prune dev deps.
# `nodejs24-devel` is required because `better-sqlite3` is a native C++
# addon and does not yet publish prebuilt binaries for Node 24 —
# `npm ci` falls back to building from source via node-gyp, which needs
# the headers at `/usr/include/node24/common.gypi`.
# ======================================================================
FROM ${BASE_IMAGE} AS studio-server-build
RUN zypper --non-interactive --no-refresh install -y nodejs24-devel \
  && zypper clean -a
WORKDIR /build/studio-server
COPY server/package.json server/package-lock.json ./
RUN npm ci --include=dev
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
RUN npm prune --omit=dev


# ======================================================================
# Stage: prod — compiled code only, smallest final image.
# ======================================================================
FROM ${BASE_IMAGE} AS prod

# Drop the baked-in launcher & its old SPA. ComfyUI's own editor frontend is kept.
RUN rm -rf /app/server /app/dist/spa

# System libs needed by custom_nodes that bind to C libraries:
#   libturbojpeg0  — APZmedia-comfyui-fast-image-save (TurboJPEG encoder)
#   libportaudio2  — ComfyUI_AudioTools + TTS Audio Suite (PortAudio runtime)
RUN zypper --non-interactive --no-refresh install -y \
      libturbojpeg0 \
      libportaudio2 \
  && zypper clean -a

# PyTorch stack — cu128 wheels for Blackwell (RTX 50-series, sm_120).
# The hardware is RTX 5090 Laptop (sm_120); torch <2.7 / cu<128 ships no
# kernel binary for that arch and every kernel launch fails with "no kernel
# image is available for execution on the device".
# torch 2.8 + cu128 + Blackwell is the combo nunchaku and xformers both ship
# matching prebuilt wheels for. numpy stays on 1.x ABI band for compat.
RUN pip install --no-cache-dir --no-deps \
      'torch==2.8.0+cu128' \
      'torchvision==0.23.0+cu128' \
      'torchaudio==2.8.0+cu128' \
      --index-url https://download.pytorch.org/whl/cu128 \
  && pip install --no-cache-dir 'numpy>=1.26,<2'

# xformers built against the same torch ABI we just installed.
# The previously-bundled xformers 2.5.7 expects torch's `rng_state/unused`
# flash-attention return schema; modern torch returns `philox_seed/philox_offset`
# and the mismatch breaks `xformers.ops` at import, which then explodes
# every diffusers consumer (InvSR, InstantCharacter, nunchaku flux pipeline).
RUN pip install --no-cache-dir --no-deps \
      xformers \
      --index-url https://download.pytorch.org/whl/cu128

# flash_attn — needed by ComfyUI-layerdiffuse (`flash_attn.flash_attn_interface`).
# Source build takes 30+ min and needs nvcc + headers we don't ship — use the
# prebuilt wheel matching our torch 2.8 + cu12.x stack. cxx11abiTRUE is what
# the PyTorch official linux wheels have used since 2.7.
RUN pip install --no-cache-dir --no-deps \
      https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl

# nunchaku — working build for torch 2.8 + cu12.8. SVDQuant Flux quantization.
# The wheel for cu12.8torch2.8 matches our stack exactly; the broken 1.2.1+torch2.11
# wheel we had on the pod was for a non-existent torch version.
RUN pip install --no-cache-dir --no-deps \
      https://github.com/nunchaku-tech/nunchaku/releases/download/v1.2.1/nunchaku-1.2.1+cu12.8torch2.8-cp312-cp312-linux_x86_64.whl

# Python deps for custom_nodes whose Manager-time pip installs went to
# /usr/local (ephemeral) and got wiped when this image was rebuilt:
#   ml_dtypes==0.5.4         PuLID-Flux2 (needs float4_e2m1fn attr)
#   facenet-pytorch          comfyui_pulid_flux_ll
#   audio-separator          various audio nodes
#   transformers==4.57.6     latest 4.x — has AutoProcessor + BertModel
#                            + Qwen3VLForConditionalGeneration. 4.57.0-4.57.5
#                            were broken (top-level reorg); 4.57.6 fixed it.
#                            5.x = major breaking changes — DO NOT bump.
#   torchcrepe               RVC Voice Conversion node
#   comfyui-manager          required by `--enable-manager` runtime flag
#   s3tokenizer              ChatterBox TTS engine node
#   descript-audio-codec     Higgs Audio 2 engine node (provides `dac`)
#   opencv-contrib-python    comfyui_layerstyle (needs cv2.ximgproc.guidedFilter)
#   packaging                k_diffusion → comfyui_jags_audiotools
#                            (setuptools 81 removed pkg_resources.packaging;
#                             top-level `packaging` is the modern shim)
RUN pip install --no-cache-dir \
      ml_dtypes==0.5.4 \
      facenet-pytorch \
      audio-separator \
      transformers==4.57.6 \
      torchcrepe \
      comfyui-manager \
      s3tokenizer \
      descript-audio-codec \
      opencv-contrib-python \
      packaging

# torchao MUST NOT be installed. The base image used to pull it in
# transitively; it has a buggy version check demanding `torch >= 2.11.0`
# (which doesn't exist) and prints a noisy "Skipping cpp extensions"
# warning every node-import. No real consumer in our stack.
RUN pip uninstall -y torchao 2>/dev/null || true

# Cosmetic-warning silencers (no functional change, just quieter logs):
#   extra_help_file.yaml       ComfyUI's launcher logs "File not found"
#                              if this optional YAML is missing. Empty stub
#                              suppresses the line; the file is read for
#                              custom hardware help text shown in the
#                              About panel — empty means default.
#   was_suite_config.json      WAS Node Suite logs a warning that
#                              ffmpeg_bin_path is unset. Patch the JSON if
#                              the node is present in the image, pointing
#                              it at the system ffmpeg. No-op if the node
#                              isn't installed (custom_nodes may live on a
#                              persistent volume in the deployment).
RUN install -d -m 755 /runner-config \
  && : > /runner-config/extra_help_file.yaml
RUN WAS_CFG=/root/ComfyUI/custom_nodes/was-node-suite-comfyui/was_suite_config.json; \
    if [ -f "$WAS_CFG" ] && command -v python3 >/dev/null; then \
      python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['ffmpeg_bin_path']='/usr/bin/ffmpeg'; json.dump(d,open(p,'w'),indent=2)" "$WAS_CFG"; \
    fi

# Studio backend (port 3002)
COPY --from=studio-server-build /build/studio-server/dist          /studio/server/dist
COPY --from=studio-server-build /build/studio-server/node_modules  /studio/server/node_modules
COPY server/package.json                                            /studio/server/package.json

# Studio frontend (static bundle, served by the backend)
COPY --from=frontend-build /build/studio/ui/dist  /studio/dist

# Entrypoint
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3002 8188
# PIP_USER=1 makes any future `pip install` default to --user, landing in
# /root/.local/lib/python3.12/site-packages/ which is on the host LVM mount
# (persistent across container restarts and OOM-kills). Without this, ad-hoc
# pip installs from `kubectl exec` or plugin-install-script paths land in
# /usr/local/.../site-packages (writable overlay, ephemeral) and vanish on
# severe restarts. See feedback_pod_npm_install.md.
ENV STUDIO_MODE=prod \
    COMFYUI_URL=http://localhost:8188 \
    PIP_USER=1
CMD ["/app/start.sh"]


# ======================================================================
# Stage: dev — source + dev deps + tsx + vite, ready for hot-reload.
#   Intended to be run with `STUDIO_MODE=dev`, optionally with host source
#   bind-mounted over /studio to live-edit from your laptop.
#   `nodejs24-devel` is kept around so an in-pod `npm rebuild` (triggered
#   when the hostPath-mounted node_modules mismatches the container arch)
#   can rebuild `better-sqlite3` without failing on missing headers.
# ======================================================================
FROM ${BASE_IMAGE} AS dev
# nodejs24-devel: needed for native rebuild of better-sqlite3 in-pod.
# libturbojpeg0 / libportaudio2: same custom_node C bindings as prod stage.
RUN zypper --non-interactive --no-refresh install -y \
      nodejs24-devel \
      libturbojpeg0 \
      libportaudio2 \
  && zypper clean -a

# Drop the baked-in launcher & old SPA.
RUN rm -rf /app/server /app/dist/spa

# Same pytorch stack as prod — see prod stage for rationale. cu128 + Blackwell.
RUN pip install --no-cache-dir --no-deps \
      'torch==2.8.0+cu128' \
      'torchvision==0.23.0+cu128' \
      'torchaudio==2.8.0+cu128' \
      --index-url https://download.pytorch.org/whl/cu128 \
  && pip install --no-cache-dir 'numpy>=1.26,<2'

RUN pip install --no-cache-dir --no-deps \
      xformers \
      --index-url https://download.pytorch.org/whl/cu128

RUN pip install --no-cache-dir --no-deps \
      https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl

RUN pip install --no-cache-dir --no-deps \
      https://github.com/nunchaku-tech/nunchaku/releases/download/v1.2.1/nunchaku-1.2.1+cu12.8torch2.8-cp312-cp312-linux_x86_64.whl

# Same python deps as prod stage — keep dev and prod custom_nodes set in sync.
RUN pip install --no-cache-dir \
      ml_dtypes==0.5.4 \
      facenet-pytorch \
      audio-separator \
      transformers==4.57.6 \
      torchcrepe \
      comfyui-manager \
      s3tokenizer \
      descript-audio-codec \
      opencv-contrib-python \
      packaging

RUN pip uninstall -y torchao 2>/dev/null || true

# Cosmetic-warning silencers — see prod stage for full rationale.
RUN install -d -m 755 /runner-config \
  && : > /runner-config/extra_help_file.yaml
RUN WAS_CFG=/root/ComfyUI/custom_nodes/was-node-suite-comfyui/was_suite_config.json; \
    if [ -f "$WAS_CFG" ] && command -v python3 >/dev/null; then \
      python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['ffmpeg_bin_path']='/usr/bin/ffmpeg'; json.dump(d,open(p,'w'),indent=2)" "$WAS_CFG"; \
    fi

# --- Studio frontend source + full deps (needed for vite dev + vite build) ---
WORKDIR /studio/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --include=dev
COPY ui/ ./

# --- Studio backend source + full deps ---
WORKDIR /studio/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --include=dev
COPY server/tsconfig.json ./
COPY server/src ./src

# Entrypoint (same script, runs the dev branch when STUDIO_MODE=dev)
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3001 3002 8188
# PIP_USER=1 — see comment in prod stage above.
ENV STUDIO_MODE=dev \
    COMFYUI_URL=http://localhost:8188 \
    PIP_USER=1
CMD ["/app/start.sh"]
