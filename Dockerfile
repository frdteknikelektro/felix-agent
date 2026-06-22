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
RUN npm run build:server

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
        poppler-utils \
        python3 \
        python3-dev \
        python3-pip \
        python3-venv \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

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
    WORKSPACE_DIR=/home/node/workspace \
    PYTHONUSERBASE=/home/node/workspace/runtime/python \
    PATH="/home/node/workspace/runtime/bin:/home/node/workspace/runtime/npm/bin:/home/node/workspace/runtime/python/bin:$PATH"

# Install harness CLIs
RUN npm install -g @openai/codex@^0.133.0 opencode-ai@^1.17.3 @anthropic-ai/claude-code@^2.1.161

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node skills ./skills
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://localhost:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
