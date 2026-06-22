# Felix Agent

A persistent AI agent that wraps an LLM backend and routes messages from Mattermost, Discord, or Slack through skill-gated turns.

```
source thread → Felix session → LLM turn → skill-gated reply
```

## Quick Start

```bash
npm install && npm run setup   # one-time
docker compose up -d           # build & start
curl http://localhost:53318/healthz
```

Open the owner console at [http://localhost:53318](http://localhost:53318), log in with `OWNER_UI_SECRET`.

## Configure

Run `npm run setup` to configure your `.env` interactively. Re-run anytime to update harness, sources, or the owner channel.

Key variables:

| Variable | Purpose |
|---|---|
| `OWNER_UI_SECRET` | Owner console login |
| `HARNESS` | `codex` or `opencode` |
| `OPENAI_API_KEY` | Required when `HARNESS=codex` |
| `OPENCODE_API_KEY` | Required when `HARNESS=opencode` |
| `MATTERMOST_TOKEN` | Enables Mattermost |
| `DISCORD_TOKEN` | Enables Discord |
| `SLACK_TOKEN` | Enables Slack |

See `.env.example` for all defaults.

## Manage

```bash
docker compose logs -f
docker compose ps
docker compose up -d --build   # rebuild on source changes
```

Pre-built image (skip local build):

```bash
cp docker-compose.image.yml docker-compose.yml
docker compose up -d
```

## Owner Console

```
http://localhost:53318/
```

Sessions, approvals, contacts, skills, and audit history. Log in with `OWNER_UI_SECRET`.

## Runtime image

The agent image (`node:24-bookworm-slim`) bundles provider-neutral batteries: Node, Python with the core data stack, and common shell/file utilities. Shared tooling lives under `workspace/runtime/` and persists across restarts.

Provider-specific operational CLIs are **not** bundled — install them on demand with the `install-tool` skill:

- AWS CLI (`aws`), `gcloud`, `kubectl`, and Terraform are excluded.
- LibreOffice and browser automation runtimes are excluded in v1.

See [docs/adr/0002-agent-runtime-image-contract.md](docs/adr/0002-agent-runtime-image-contract.md) for the full contract.

## Development

```bash
npm install
npm run setup                 # initial setup or update .env
npm test                      # vitest
npm run build                 # tsc
```

## Project layout

```
src/          core · adapters (codex/opencode/mattermost/discord/slack) · server
tests/        vitest unit tests
skills/       bundled skills shipped in the image
workspace/    runtime data — threads, contacts, skills, approvals
```

Skills are copied from `skills/` into `workspace/catalog/skills/` on startup. Manual edits inside `workspace/catalog/skills/` are overwritten on restart.
