# Felix Agent — Agent Guide

Felix is a persistent thread/session agent that wraps Codex (OpenAI CLI) and routes messages from source adapters (Mattermost, Discord, or Slack) through skill-gated LLM turns.

## Project layout

```
src/
  core/          ports.ts · routing.ts · decide-turn.ts · schemas.ts
  adapters/      codex/ · opencode/ · mattermost/ · discord/ · slack/
  slices/        sessions/ · events/ · approvals/ · contacts/ · skills/ · audit/
  server/        app.ts (HTTP + owner console) · routes.ts (API route table) · owner-client.ts
  engine.ts      main dispatch loop
  index.ts       composition root — boots engine, supervises sources, handles SIGTERM
  config.ts      env var loading
tests/           vitest unit tests (no network, no disk)
workspace/       runtime data — threads, contacts, skills, approvals (git-ignored)
skills/          bundled skills shipped in the image
config/          local secrets — .env file (git-ignored)
```

## Dev workflow

```bash
npm install
npm run dev          # tsx watch — no build step needed
npm run lint         # tsc --noEmit
npm test             # vitest run (104 tests, ~1 s)
npm run build        # tsc → dist/
npm start            # node dist/index.js
```

## Docker — build and run

Image name convention: `felix-agent-docker`

**Build:**
```bash
docker build \
  --build-arg AGENT_UID=$(id -u) \
  --build-arg AGENT_GID=$(id -g) \
  -t felix-agent-docker .
```

**Run:**
```bash
docker run -d \
  --name felix-agent-docker \
  -p 53318:3000 \
  -v /path/to/project/config/.env:/run/secrets/.env:ro \
  -v /path/to/project/workspace:/home/agent/workspace \
  felix-agent-docker:latest
```

- Port `53318` on host → `3000` in container (owner console + healthz)
- `/run/secrets/.env` — secret env file (see Config below)
- `/home/agent/workspace` — persistent runtime data (threads, contacts, approvals, skills)
- Build the image with `AGENT_UID` / `AGENT_GID` matching the host user that owns the bind-mounted workspace.

**Rebuild and relaunch (full cycle):**
```bash
docker stop felix-agent-docker && docker rm felix-agent-docker
docker build -t felix-agent-docker .
docker run -d \
  --name felix-agent-docker \
  -p 53318:3000 \
  -v $(pwd)/config/.env:/run/secrets/.env:ro \
  -v $(pwd)/workspace:/home/agent/workspace \
  felix-agent-docker:latest
```

**Health check:**
```bash
curl http://localhost:53318/healthz   # → {"ok":true}
```

**Logs:**
```bash
docker logs felix-agent-docker
docker logs felix-agent-docker --since 10m
```

## Agent runtime image

Felix uses a batteries-included Agent runtime image for provider-neutral skill work. Keep `node:24-bookworm-slim` as the base unless there is a new ADR.

Stable Runtime capabilities:

- Node execution
- Python execution with `pip` and `venv` support
- Core data stack for reporting and chart generation
- Basic image and PDF utility work
- Shell, network, archive, and compression utilities
- Git/project editing basics
- Shared runtime tooling under `workspace/runtime/`

Provider-specific operational CLIs are intentionally excluded from the image, including `aws`, `gcloud`, `kubectl`, and `terraform`. Use the `install-tool` skill or another explicit setup path for those.

LibreOffice and browser automation runtimes are excluded from v1. See `docs/adr/0002-agent-runtime-image-contract.md`.

## Config

Runtime config is loaded from environment variables. In production the container reads `/run/secrets/.env` (mounted read-only). Locally copy `.env.example` → `config/.env` and fill in values.

Key variables:

| Variable | Required for | Description |
|---|---|---|
| `OWNER_UI_SECRET` | owner console | shared secret for login |
| `OPENAI_API_KEY` | Codex harness | OpenAI API key |
| `HARNESS` | — | `codex` (default) or `opencode` |
| `WORKSPACE_DIR` | — | default `/home/agent/workspace` |
| `HEALTH_PORT` | — | default `3000` |
| `CODEX_MODEL` | — | default `gpt-5.4-mini` |
| `MATTERMOST_TOKEN` | Mattermost | enables the adapter when set |
| `DISCORD_TOKEN` | Discord | enables the adapter when set |
| `SLACK_TOKEN` | Slack | enables the adapter when set |

See `.env.example` for the complete list with all defaults.

## Owner console

Available at `http://localhost:53318/` (or whichever host port maps to 3000).
Login with `OWNER_UI_SECRET`. Sessions, approvals, contacts, skills, audit log.

## Architecture notes

- **Ports & adapters**: `Harness` and `SourceAdapter` interfaces in `src/core/ports.ts`. Concrete implementations: `CodexHarness` / `OpencodeHarness` (harnesses); `MattermostAdapter` / `DiscordAdapter` / `SlackAdapter` (sources).
- **Pure core**: `decideTurnResult()` and routing predicates have zero IO — fully unit-testable.
- **Supervised source**: Each `startXxxSource` returns `{ stop(), done }`. The supervisor in `index.ts` awaits `done`. Transient connection drops are handled per adapter: Mattermost uses exponential backoff (1 s → 30 s); Discord and Slack use library-managed reconnection.
- **Graceful shutdown**: SIGTERM → stop all sources → `engine.drain(15 s)` → close HTTP server → hard exit after 10 s.
- **Schemas**: Zod schemas in `src/core/schemas.ts` are the single source of truth for all persisted JSON records. `readJsonParsed()` validates on read.
- **Route table**: `src/server/routes.ts` owns all API routes. Adding a route = one entry in `API_ROUTES`, not a new if-branch.

## Git rules

- **Do not push to GitHub** — local merges to `main` only.
- Feature branch → commit → `git merge --ff-only` → `git branch -d`.
