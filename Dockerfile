ARG NODE_IMAGE=node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG GO_IMAGE=golang:1.26.5-trixie@sha256:117e07f49461abb984fc8aef661432461ff43d06faa22c3b73af6a49ce325cb9

FROM ${GO_IMAGE} AS go-tools-build
ARG WACLI_COMMIT=c9a5100308166bc2657472fd63f30a1aed5fbfbb
ARG WACLI_SOURCE_SHA256=7003fc753f2de0c940a8d9235a0e0a82a71f551d6726ecfa2fce3111d4276717
WORKDIR /src
RUN curl -fsSL "https://github.com/openclaw/wacli/archive/${WACLI_COMMIT}.tar.gz" -o /tmp/wacli-source.tar.gz \
    && echo "${WACLI_SOURCE_SHA256}  /tmp/wacli-source.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/wacli-source.tar.gz --strip-components=1 \
    && rm /tmp/wacli-source.tar.gz \
    && GOTOOLCHAIN=local CGO_ENABLED=1 go build -trimpath -ldflags="-s -w -buildid=" -o /out/wacli ./cmd/wacli \
    && go version -m /out/wacli | grep -F 'go1.26.5'

ARG GOG_VERSION=0.34.0
ARG GOG_SOURCE_SHA256=5ae7664dc9e79c0aad57864551e9f7db2a4be3a995e34db7a54bb1d01cba5af9
WORKDIR /gog
RUN curl -fsSL "https://github.com/openclaw/gogcli/archive/refs/tags/v${GOG_VERSION}.tar.gz" -o /tmp/gog-source.tar.gz \
    && echo "${GOG_SOURCE_SHA256}  /tmp/gog-source.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gog-source.tar.gz --strip-components=1 \
    && rm /tmp/gog-source.tar.gz \
    && GOTOOLCHAIN=local CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o /out/gog ./cmd/gog \
    && go version -m /out/gog | grep -F 'go1.26.5'

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# No apt toolchain needed: nothing in the dependency tree compiles via node-gyp
# (sqlite goes through the node:sqlite built-in; the remaining install scripts
# only download prebuilt binaries).
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Build the React owner console first (its deps stay in the build stage only).
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

COPY src ./src
RUN npm run build:server \
    && cp src/AGENTS.md src/WORKSPACE_FOLDER_STRUCTURE.md dist/

# Prod-only node_modules for the runtime image, pruned from the build stage's install
# (in its own stage so the setup target below can still reuse the full dev install).
FROM build AS prod-deps
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
RUN npm install --global npm@12.0.1 \
    && npm --version \
    && npm cache clean --force \
    && rm -rf /root/.npm
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dumb-init \
        ffmpeg \
        ghostscript \
        git \
        imagemagick \
        jq \
        openssh-client \
        pandoc \
        poppler-utils \
        python3 \
        python3-pip \
        python3-venv \
        rsync \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

# Build the bundled Go CLIs from pinned sources with a supported toolchain.
COPY --from=go-tools-build /out/wacli /usr/local/bin/wacli
COPY --from=go-tools-build /out/gog /usr/local/bin/gog
RUN wacli --version \
    && gog --version \
    && echo "bundled Go CLIs installed ok"

# Install whisper.cpp CLI (speech-to-text transcription, available to every source
# adapter) — prebuilt release binary + its sibling shared libs (ggml's CPU backends
# dispatch by runtime cpuid, so all variants ship together); trimmed of the unrelated
# parakeet/test/bench/server binaries. No model is baked in here — the LLM downloads
# one on first use (see skills/listen-speak/SKILL.md § STT).
ARG WHISPER_CPP_VERSION=1.9.1
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) asset_arch=arm64; asset_sha256=e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3 ;; \
         x86_64)  asset_arch=x64; asset_sha256=f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5 ;; \
         *)       echo "whisper.cpp: no prebuilt release for $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-ubuntu-${asset_arch}.tar.gz" \
         -o /tmp/whisper.tar.gz \
    && echo "${asset_sha256}  /tmp/whisper.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/whisper.cpp \
    && tar -xzf /tmp/whisper.tar.gz -C /opt/whisper.cpp --strip-components=1 \
    && rm /tmp/whisper.tar.gz \
    && rm -f /opt/whisper.cpp/parakeet-cli /opt/whisper.cpp/parakeet-quantize /opt/whisper.cpp/libparakeet.so* \
             /opt/whisper.cpp/test-* /opt/whisper.cpp/whisper-bench /opt/whisper.cpp/bench \
             /opt/whisper.cpp/whisper-server /opt/whisper.cpp/whisper-quantize /opt/whisper.cpp/main \
             /opt/whisper.cpp/whisper-vad-speech-segments \
    && ln -s /opt/whisper.cpp/whisper-cli /usr/local/bin/whisper-cli \
    && whisper-cli --help 2>&1 | grep -qi "usage" \
    && echo "whisper-cli installed ok"

# Install piper TTS (text-to-speech synthesis) — prebuilt release binary.
# No voice model is baked in; the LLM downloads one on first use via the
# listen-speak skill (skills/listen-speak/SKILL.md). Smoke test is executability
# only — piper needs a voice model for any real invocation.
ARG PIPER_VERSION=2023.11.14-2
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) asset_arch=aarch64; asset_sha256=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb ;; \
         x86_64)  asset_arch=x86_64; asset_sha256=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 ;; \
         *)       echo "piper: no prebuilt release for $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${asset_arch}.tar.gz" \
         -o /tmp/piper.tar.gz \
    && echo "${asset_sha256}  /tmp/piper.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/piper \
    && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
    && rm /tmp/piper.tar.gz \
    && ln -s /opt/piper/piper /usr/local/bin/piper \
    && test -x /opt/piper/piper \
    && echo "piper installed ok"

# The complete transitive Python graph is version- and hash-locked. Binary-only
# installation keeps compiler toolchains out of the runtime image.
COPY requirements-runtime.txt ./requirements-runtime.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages --ignore-installed --only-binary=:all: --require-hashes \
        -r requirements-runtime.txt \
    && node --version \
    && python3 --version \
    && python3 - <<'PY'
import dateutil
import lxml
import matplotlib
import numpy
import openpyxl
import pandas
import pdfplumber
import PIL
import pypdf
import reportlab
import requests
import seaborn
import xlsxwriter

print("python core data + office stack ok")
PY

WORKDIR /app

ENV NODE_ENV=production \
    HOME=/home/node \
    USER=node \
    WORKSPACE_DIR=/home/node \
    GOG_HOME=/home/node/.config/gogcli \
    GOG_KEYRING_BACKEND=file \
    FELIX_SETUP_ENV_FILE=/config/.env \
    NODE_PATH=/app/node_modules \
    PYTHONUSERBASE=/home/node/runtime/python \
    PATH="/app/node_modules/.bin:/home/node/runtime/bin:/home/node/runtime/npm/bin:/home/node/runtime/python/bin:$PATH"

# package.json stays: its "type": "module" drives ESM resolution for dist/*.js.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

COPY --chown=node:node skills ./skills
COPY --chown=node:node scripts/setup.mjs ./scripts/setup.mjs
COPY --chown=node:node scripts/setup-support.mjs ./scripts/setup-support.mjs
COPY --chown=node:node .env.example ./.env.example
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://localhost:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

# ── Setup stage ─────────────────────────────────────────────────────────────
# The runtime image already contains the setup wizard and its production dependency,
# so this target only changes the default command for local setup composition.
FROM runtime AS setup
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "scripts/setup.mjs"]

# Keep the default (last) build target deployable. The setup image remains
# available only when callers explicitly select --target setup.
FROM runtime AS production
