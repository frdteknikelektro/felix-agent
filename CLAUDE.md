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
.env             local secrets (git-ignored)
.env.example     env template (tracked)
```

## Dev workflow

```bash
npm install
npm run setup          # interactive .env setup
npm run dev            # tsx watch — no build step needed
npm run lint         # tsc --noEmit
npm test             # vitest run (104 tests, ~1 s)
npm run build        # tsc → dist/
npm start            # node dist/index.js
```

## Docker — compose (recommended)

```bash
# First-time setup
npm run setup

# Build & start (Unix / WSL):
UID=$(id -u) GID=$(id -g) docker compose up -d
# Build & start (Windows PowerShell / CMD):
docker compose up -d

# Manage
docker compose ps
docker compose logs -f
curl http://localhost:53318/healthz   # → {"ok":true}

# Rebuild on source changes
docker compose up -d --build
```

Set `UID` / `GID` to match the host user that owns the bind-mounted `workspace/` directory. On macOS and Windows Docker Desktop the defaults (1000:1000) usually work.

### docker run (manual)

```bash
docker build -t felix-agent .

docker run -d \
  --name felix-agent \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \    # omit --user on Windows
  -p 53318:3000 \
  -v $(pwd)/.env:/run/secrets/.env:ro \
  -v $(pwd)/workspace:/home/node/workspace \
  felix-agent:latest
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

Runtime config is loaded from environment variables. In production with docker-compose, `.env` is mounted read-only at `/run/secrets/.env`. Locally copy `.env.example` → `.env` and fill in values.

Key variables:

| Variable | Required for | Description |
|---|---|---|
| `OWNER_UI_SECRET` | owner console | shared secret for login |
| `OPENAI_API_KEY` | Codex harness | OpenAI API key |
| `HARNESS` | — | `codex` (default) or `opencode` |
| `WORKSPACE_DIR` | — | default `/home/node/workspace` |
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
