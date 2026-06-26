# Felix Agent — Agent Guide

Felix is a persistent thread/session agent that wraps Codex (OpenAI CLI), OpenCode, or Claude Code and routes messages from source adapters (Mattermost, Discord, Slack, or WhatsApp) through skill-gated LLM turns.

## Project layout

```
src/
  core/          ports.ts · routing.ts · decide-turn.ts · schemas.ts
  adapters/      codex/ · opencode/ · claude-code/ · mattermost/ · discord/ · slack/ · whatsapp/
  slices/        sessions/ · events/ · approvals/ · contacts/ · skills/ · audit/
  server/        app.ts (HTTP + static SPA + SSE) · routes.ts (API route table) · sse.ts (dashboard stream)
  engine.ts      main dispatch loop
  index.ts       composition root — boots engine, supervises sources, handles SIGTERM
  config.ts      env var loading
web/             owner console SPA — React + Vite + Tailwind (own package.json/lockfile)
tests/           vitest unit tests (no network, no disk)
workspace/       runtime data — threads, contacts, skills, approvals (git-ignored)
skills/          bundled skills shipped in the image
.env             local secrets (git-ignored)
.env.example     env template (tracked)
```

The owner console is a React SPA in `web/`, built to `web/dist` and served as static
assets by the Node HTTP server. The server exposes a REST API under `/api/*` and a live
dashboard stream at `/events/dashboard` (SSE). The bundle is served unauthenticated (it
contains its own login screen); `/api/*` and `/events/*` require the owner session cookie.

## Dev workflow

```bash
npm install
npm run setup          # interactive .env setup (local dev only — Docker users: docker compose run --rm setup)
npm run dev            # tsx watch — API server (serves built web/dist if present)
npm run dev:web        # optional: Vite dev server on :5173 with HMR, proxies /api + /events
npm run lint         # tsc --noEmit
npm test             # vitest run
npm run build:web    # install web deps + build SPA → web/dist
npm run build        # build:web + build:server → dist/ (+ web/dist)
npm start            # node dist/index.js
```

For UI development run `npm run dev` and `npm run dev:web` together and open the Vite URL
(:5173) for hot-reload. To just run Felix, the Docker image builds the SPA at image-build
time and serves it — no local `npm` needed (see below).

## Docker — compose (recommended)

```bash
# First-time setup (no Node.js required — just Docker)
docker compose run --rm setup

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
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid \
  --tmpfs /home/node/.codex:rw,noexec,nosuid \
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

Runtime config is loaded from environment variables. In production with docker-compose, `.env` is injected as a Docker secret at `/run/secrets/.env`. Locally copy `.env.example` → `.env` and fill in values.

Key variables:

| Variable | Required for | Description |
|---|---|---|
| `OWNER_UI_SECRET` | owner console | shared secret for login |
| `OPENAI_API_KEY` | Codex harness | OpenAI API key (or use OAuth) |
| `OPENAI_CODEX_AUTH_JSON` | Codex harness (OAuth) | ChatGPT Plus auth JSON (populated by setup) |
| `ANTHROPIC_API_KEY` | Claude Code harness | Anthropic API key |
| `HARNESS` | — | `codex` (default), `opencode`, or `claude-code` |
| `WORKSPACE_DIR` | — | default `/home/node/workspace` |
| `CODEX_MODEL` | — | default `gpt-5.4-mini` |
| `CLAUDE_CODE_MODEL` | — | default `sonnet` |
| `USAGE_TZ` | — | IANA timezone for usage day/week/month boundaries (default `UTC`) |
| `MATTERMOST_TOKEN` | Mattermost | enables the adapter when set |
| `DISCORD_TOKEN` | Discord | enables the adapter when set |
| `SLACK_TOKEN` | Slack | enables the adapter when set |
| `WHATSAPP_BOT_NAME` | WhatsApp | enables the adapter when set |

See `.env.example` for the complete list with all defaults.

## Owner console

Available at `http://localhost:53318/` (or whichever host port maps to 3000).
Login with `OWNER_UI_SECRET`. Sessions, approvals, contacts, skills, audit log.

## Architecture notes

- **Ports & adapters**: `Harness` and `SourceAdapter` interfaces in `src/core/ports.ts`. Concrete implementations: `CodexHarness` / `OpencodeHarness` / `ClaudeCodeHarness` (harnesses); `MattermostAdapter` / `DiscordAdapter` / `SlackAdapter` / `WhatsAppAdapter` (sources).
- **Pure core**: `decideTurnResult()` and routing predicates have zero IO — fully unit-testable.
- **Supervised source**: Each `startXxxSource` returns `{ stop(), done }`. The supervisor in `index.ts` awaits `done`. Transient connection drops are handled per adapter: Mattermost uses exponential backoff (1 s → 30 s); Discord and Slack use library-managed reconnection; WhatsApp reconnects via wacli's internal `--max-reconnect 0` (indefinite).
- **Graceful shutdown**: SIGTERM → stop all sources → `engine.drain(15 s)` → close HTTP server → hard exit after 10 s.
- **Schemas**: Zod schemas in `src/core/schemas.ts` are the single source of truth for all persisted JSON records. `readJsonParsed()` validates on read.
- **Route table**: `src/server/routes.ts` owns all API routes. Adding a route = one entry in `API_ROUTES`, not a new if-branch.

## Git rules

- **Default workflow is local:** feature branch → commit → `git merge --ff-only` into `main` → `git branch -d`. No merge commits.
- **The agent never pushes on its own.** Committing and local merges are fine without asking; `git push` is not part of the default flow.
- **Push only when the owner explicitly asks** ("push", "open a PR"). Even then, confirm before pushing to `origin/main`, and prefer pushing a branch + opening a PR over pushing straight to `main`.
