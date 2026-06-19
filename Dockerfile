FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
COPY tests ./tests
COPY skills ./skills
RUN npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        chromium \
        chromium-sandbox \
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
        xvfb \
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

RUN npm install -g agent-browser

WORKDIR /app

ENV NODE_ENV=production \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_IDLE_TIMEOUT_MS=300000 \
    HOME=/home/node \
    WORKSPACE_DIR=/home/node/workspace \
    PYTHONUSERBASE=/home/node/workspace/runtime/python \
    PATH="/home/node/workspace/runtime/bin:/home/node/workspace/runtime/python/bin:$PATH"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node skills ./skills
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://127.0.0.1:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
