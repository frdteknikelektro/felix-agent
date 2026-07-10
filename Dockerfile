FROM node:24-bookworm-slim AS build
WORKDIR /app

# No apt toolchain needed: nothing in the dependency tree compiles via node-gyp
# (sqlite goes through the node:sqlite built-in; the remaining install scripts
# only download prebuilt binaries).
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Build the React owner console first (its deps stay in the build stage only).
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install
COPY web ./web
RUN npm --prefix web run build

COPY src ./src
RUN npm run build:server \
    && cp src/AGENTS.md src/WORKSPACE_FOLDER_STRUCTURE.md dist/

# Prod-only node_modules for the runtime image, pruned from the build stage's install
# (in its own stage so the setup target below can still reuse the full dev install).
FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
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

# Install wacli (WhatsApp CLI) — statically linked Go binary with cgo+SQLite
ARG WACLI_VERSION=0.11.1
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) tarch=arm64 ;; \
         armv7l)  tarch=arm ;; \
         *)       tarch=amd64 ;; \
       esac \
    && curl -fsSL "https://github.com/openclaw/wacli/releases/download/v${WACLI_VERSION}/wacli_${WACLI_VERSION}_linux_${tarch}.tar.gz" \
         -o /tmp/wacli.tar.gz \
    && tar -xzf /tmp/wacli.tar.gz -C /usr/local/bin wacli \
    && rm /tmp/wacli.tar.gz \
    && chmod +x /usr/local/bin/wacli \
    && wacli --version

# Install whisper.cpp CLI (speech-to-text transcription, available to every source
# adapter) — prebuilt release binary + its sibling shared libs (ggml's CPU backends
# dispatch by runtime cpuid, so all variants ship together); trimmed of the unrelated
# parakeet/test/bench/server binaries. No model is baked in here — adapters download one
# on first use (see buildAudioAttachmentInstructions in src/core/harness-common.ts).
ARG WHISPER_CPP_VERSION=1.9.1
RUN arch="$(uname -m)" \
    && case "$arch" in \
         aarch64) wtarch=arm64 ;; \
         x86_64)  wtarch=x64 ;; \
         *)       echo "whisper.cpp: no prebuilt release for $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-ubuntu-${wtarch}.tar.gz" \
         -o /tmp/whisper.tar.gz \
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

# --only-binary=:all: — the image ships no compiler, so a source-dist fallback would
# fail obscurely mid-build; force prebuilt wheels and fail loudly at resolve time instead.
RUN python3 -m pip install --no-cache-dir --break-system-packages --only-binary=:all: \
        lxml \
        markitdown \
        matplotlib \
        numpy \
        openpyxl \
        pandas \
        pdfplumber \
        pillow \
        pypdf \
        python-dateutil \
        reportlab \
        requests \
        seaborn \
        xlsxwriter \
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
    NODE_PATH=/app/node_modules \
    PYTHONUSERBASE=/home/node/runtime/python \
    GIT_AUTHOR_NAME="felix-agent" \
    GIT_AUTHOR_EMAIL="felix@agent" \
    GIT_COMMITTER_NAME="felix-agent" \
    GIT_COMMITTER_EMAIL="felix@agent" \
    PATH="/app/node_modules/.bin:/home/node/runtime/bin:/home/node/runtime/npm/bin:/home/node/runtime/python/bin:$PATH"

# package.json stays: its "type": "module" drives ESM resolution for dist/*.js.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

COPY --chown=node:node skills ./skills
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

RUN echo "node:x:1002:1002::/home/node:/bin/sh" >> /etc/passwd

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://localhost:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

# ── Setup stage ─────────────────────────────────────────────────────────────
# Reuses the build stage's full dev install (setup.mjs needs @inquirer/prompts,
# a devDependency) instead of running a second npm ci in a dedicated stage.
FROM runtime AS setup
COPY --from=build /app/node_modules /app/node_modules
COPY scripts/setup.mjs /app/scripts/setup.mjs
COPY .env.example /app/.env.example
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "scripts/setup.mjs"]
