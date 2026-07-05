FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Build the React owner console first (its deps stay in the build stage only).
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install
COPY web ./web
RUN npm --prefix web run build

COPY src ./src
COPY tests ./tests
COPY skills ./skills
RUN npm run build:server \
    && cp src/AGENTS.md src/WORKSPACE_FOLDER_STRUCTURE.md dist/

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        dumb-init \
        ghostscript \
        git \
        imagemagick \
        jq \
        openssh-client \
        rsync \
        poppler-utils \
        python3 \
        python3-dev \
        python3-pip \
        python3-venv \
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

RUN python3 -m pip install --no-cache-dir --break-system-packages \
        matplotlib \
        numpy \
        openpyxl \
        pandas \
        pillow \
        python-dateutil \
        requests \
        seaborn \
        xlsxwriter \
    && node --version \
    && python3 --version \
    && python3 - <<'PY'
import dateutil
import matplotlib
import numpy
import openpyxl
import pandas
import PIL
import requests
import seaborn
import xlsxwriter

print("python core data stack ok")
PY

WORKDIR /app

ENV NODE_ENV=production \
    HOME=/home/node \
    USER=node \
    WORKSPACE_DIR=/home/node \
    PYTHONUSERBASE=/home/node/runtime/python \
    GIT_AUTHOR_NAME="felix-agent" \
    GIT_AUTHOR_EMAIL="felix@agent" \
    GIT_COMMITTER_NAME="felix-agent" \
    GIT_COMMITTER_EMAIL="felix@agent" \
    PATH="/app/node_modules/.bin:/home/node/runtime/bin:/home/node/runtime/npm/bin:/home/node/runtime/python/bin:$PATH"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

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
FROM node:24-bookworm-slim AS setup-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/setup.mjs ./scripts/setup.mjs
COPY .env.example ./.env.example

FROM runtime AS setup
COPY --from=setup-deps /app/node_modules /app/node_modules
COPY --from=setup-deps /app/scripts/setup.mjs /app/scripts/setup.mjs
COPY --from=setup-deps /app/.env.example /app/.env.example
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "scripts/setup.mjs"]
