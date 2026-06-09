# syntax=docker/dockerfile:1.6
#
# ComfyUI Studio — extends the upstream beclab image with our backend + UI.
#
# Two final targets:
#   prod (default) — compiled JS, runtime deps only, static frontend bundle. Small & fast.
#   dev            — source + dev deps included, ready for tsx watch + vite --host.
#
# Pick which to build with `--target prod` or `--target dev`.

ARG BASE_IMAGE=docker.io/beclab/comfyui:v0.22.0

# ======================================================================
# Stage: frontend-build — throwaway; we only need its dist/.
# UI imports type-only Zod schemas from server/src/contracts/* via the
# `@server/*` tsconfig path alias (resolves to ../server/src/*). The server
# source must be present in the build context so vite's TS resolver finds it.
# ======================================================================
FROM ${BASE_IMAGE} AS frontend-build
WORKDIR /build/studio/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --include=dev
# Symlink server/node_modules → ui/node_modules so tsc can resolve `zod`
# (and any other shared dep) when it follows the @server/* path alias into
# server/src/contracts/*.ts. Only the contracts leaf is copied; no
# server-internal modules (express, better-sqlite3, etc.) are present.
RUN mkdir -p /build/studio/server \
  && ln -s /build/studio/ui/node_modules /build/studio/server/node_modules
COPY server/src/contracts /build/studio/server/src/contracts
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

# Python runtime dependencies (torch, xformers, flash_attn, nunchaku,
# transformers, audio-separator, ...) are installed at pod start by
# docker/start.sh — they need to land in /root/.local/ which is mounted
# from a hostPath volume at runtime, so any Dockerfile pip install gets
# hidden behind the mount. start.sh idempotently installs them on first
# boot and skips on subsequent boots via a marker file.

# Remove the base image's bundled xformers + flash_attn + cv2 so they
# don't shadow our runtime-installed versions. xformers 0.0.35 in the base
# image references torch.distributed.GroupName (removed in torch 2.8) and
# breaks every diffusers consumer when left in place. cv2 lives across
# three conflicting variants (-python, -python-headless, -contrib-python-
# headless) that overwrite each other and leave ximgproc empty.
RUN rm -rf /usr/local/lib64/python3.12/site-packages/xformers* \
           /usr/local/lib64/python3.12/site-packages/flash_attn* \
           /usr/local/lib64/python3.12/site-packages/cv2* \
           /usr/local/lib/python3.12/site-packages/xformers* \
           /usr/local/lib/python3.12/site-packages/flash_attn* \
           /usr/local/lib/python3.12/site-packages/cv2* 2>/dev/null || true

# extra_help_file.yaml: ComfyUI's launcher logs "File not found" if this
# optional YAML is missing. Empty stub silences the line; lives at
# /runner-config/ which is image-baked (no volume mount), so this survives.
RUN install -d -m 755 /runner-config \
  && : > /runner-config/extra_help_file.yaml

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

# Python runtime dependencies are installed at pod start by docker/start.sh.
# See prod stage for rationale.
RUN install -d -m 755 /runner-config \
  && : > /runner-config/extra_help_file.yaml

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
