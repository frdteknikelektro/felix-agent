FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
COPY tests ./tests
COPY skills ./skills
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG AGENT_UID=1000
ARG AGENT_GID=1000
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
    && groupadd --gid "${AGENT_GID}" agent \
    && useradd --create-home --uid "${AGENT_UID}" --gid "${AGENT_GID}" --shell /bin/bash agent \
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
    HOME=/home/agent \
    WORKSPACE_DIR=/home/agent/workspace \
    PYTHONUSERBASE=/home/agent/workspace/runtime/python \
    PATH="/home/agent/workspace/runtime/bin:/home/agent/workspace/runtime/python/bin:$PATH" \
    HEALTH_PORT=3000 \
    CODEX_MODEL=gpt-5.4-mini \
    CODEX_BYPASS_SANDBOX=true \
    CODEX_TIMEOUT_SECONDS=1800 \
    OPENCODE_MODEL=opencode/deepseek-v4-flash-free

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /home/agent/workspace /home/agent/workspace/runtime/bin /home/agent/workspace/runtime/tools /home/agent/workspace/runtime/python/bin /home/agent/config \
    && chown -R agent:agent /home/agent

COPY --chown=agent:agent skills ./skills
COPY --from=build --chown=agent:agent /app/dist ./dist

USER agent

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://127.0.0.1:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
