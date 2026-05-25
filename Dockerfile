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
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && useradd --create-home --uid 1001 --shell /bin/bash agent \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOME=/home/agent \
    WORKSPACE_DIR=/home/agent/workspace \
    HEALTH_PORT=3000 \
    CODEX_MODEL=gpt-5.4-mini \
    CODEX_BYPASS_SANDBOX=true \
    CODEX_TIMEOUT_SECONDS=1800

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /home/agent/workspace /home/agent/config \
    && chown -R agent:agent /home/agent

COPY --chown=agent:agent skills ./skills
COPY --from=build --chown=agent:agent /app/dist ./dist

USER agent

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node --input-type=module -e "const res = await fetch('http://127.0.0.1:3000/healthz'); if (!res.ok) process.exit(1); const body = await res.json().catch(() => null); if (!body || body.ok !== true) process.exit(1);"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
