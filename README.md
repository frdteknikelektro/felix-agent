# 🦊 Felix Agent

A persistent AI agent that wraps an LLM backend (Codex, OpenCode, or Claude Code) and routes messages from Mattermost, Discord, Slack, or WhatsApp through skill-gated turns.

> 🦊 Felix runs as a Docker container with a live owner console for monitoring sessions, approving skills, and managing contacts.

```
💬 source thread → 🧵 Felix session → 🤖 LLM turn → 🛡️ skill-gated reply
```

## 🚀 Quick Start

You only need **Docker** — no Node.js, Python, or anything else.

```bash
# Step 1 — Clone the repo
git clone https://github.com/frdteknikelektro/felix-agent.git
cd felix-agent

# Step 2 — First-time setup: builds the image, then runs the interactive config wizard
docker compose run --rm --build setup

# Step 3 — Start Felix in the background
docker compose up -d

# Step 4 — Verify it's running
curl http://localhost:53318/healthz   # → {"ok":true}
```

> 🖥️ Open **http://localhost:53318** — log in with the `OWNER_UI_SECRET` you set during setup.

### ⚠️ Re-running setup after source changes

`docker compose run --rm setup` reuses the **cached image**. If you've pulled new code or modified the Dockerfile, add `--build` to rebuild first:

```bash
docker compose run --rm --build setup
```

Without `--build` you'll silently get the old setup script. Same applies to `docker compose up` — use `docker compose up -d --build` after source changes.

## ⚙️ Configure

Run `docker compose run --rm --build setup` to configure your `.env` interactively. Re-run anytime to update harness, sources, or the owner channel.

| Variable | Purpose |
|---|---|
| 🔑 `OWNER_UI_SECRET` | Owner console login |
| 🤖 `HARNESS` | `codex`, `opencode`, or `claude-code` |
| 🧠 `OPENAI_API_KEY` | Required when `HARNESS=codex` (or use OAuth) |
| 🧠 `OPENCODE_API_KEY` | Required when `HARNESS=opencode` |
| 🧠 `ANTHROPIC_API_KEY` | Required when `HARNESS=claude-code` |
| 🔀 `NINEROUTER_ENABLED` | Optional override that routes the active harness through 9router |
| 💬 `MATTERMOST_TOKEN` | Enables Mattermost |
| 🎮 `DISCORD_TOKEN` | Enables Discord |
| 💼 `SLACK_TOKEN` | Enables Slack |
| 📱 `WHATSAPP_BOT_NAME` | Enables WhatsApp |

> 💡 See `.env.example` for all defaults.

### 9router Override

Felix can keep the selected harness (`codex`, `opencode`, or `claude-code`) while routing model calls through a [9router](https://github.com/decolua/9router) gateway. Enable it in setup, or set:

```bash
NINEROUTER_ENABLED=true
NINEROUTER_KEY=...
NINEROUTER_MODEL=...
NINEROUTER_URL=https://your-9router-host.example
```

`NINEROUTER_URL` is the bare gateway base (no `/v1`). Each harness derives the
endpoint it needs: Codex and Opencode append `/v1` for the OpenAI-compatible API,
and Claude Code appends `/v1/messages` for the Anthropic API.

Harness behavior when enabled:

- `codex` uses a runtime `model_providers.9router` config and passes `NINEROUTER_KEY`, the `/v1` base URL, and `NINEROUTER_MODEL`.
- `claude-code` uses `NINEROUTER_KEY` as `ANTHROPIC_AUTH_TOKEN`, `NINEROUTER_URL` as `ANTHROPIC_BASE_URL`, and `NINEROUTER_MODEL`.
- `opencode` injects a runtime custom provider with `OPENCODE_CONFIG_CONTENT` and runs `--model 9router/<NINEROUTER_MODEL>`.

## 🐳 Docker

```bash
# First run (builds the image, then starts):
docker compose up -d --build

# Subsequent starts (reuses cached image):
UID=$(id -u) GID=$(id -g) docker compose up -d   # Unix / WSL
docker compose up -d                              # Windows Docker Desktop

# Rebuild after source changes or git pull:
docker compose up -d --build

# Day-to-day commands:
docker compose logs -f        # tail logs
docker compose ps             # check status
docker compose restart felix  # restart the agent
docker compose down           # stop everything
```

### 🖼️ Cached image pitfall

Docker caches the image tag `felix-agent:latest`. When you `git pull` new code or edit the Dockerfile, **Docker won't rebuild unless you tell it to**. Always use `--build` after source changes:

```bash
docker compose run --rm --build setup   # re-run setup with fresh code
docker compose up -d --build            # restart with fresh code
```

> 🔒 **Security:** Secrets are injected via Docker secrets (not bind mounts). Container runs with `cap_drop: ALL` and read-only rootfs.

> 📦 Prefer a pre-built image? Swap in the published image:
> ```bash
> cp docker-compose.image.yml docker-compose.yml   # uses frdinawan/felix-agent:latest from Docker Hub
> docker compose up -d
> ```

## 🖥️ Owner Console

```
http://localhost:53318/
```

A live React monitoring dashboard — 🌙 dark by default with a 🌞 light toggle:

- 📊 **Dashboard** — real-time stat tiles, pending approvals, live activity feed, and active sessions (streamed over Server-Sent Events)
- 💬 **Sessions** — threads grouped by source, opened as a WhatsApp-style chat view
- 🛡️ **Approvals** — approve or reject skill permission requests inline
- ⚡ **Approval shortcuts** — use `👌` for once, `👍` for always, or `🙏` to reject; Felix keeps the legacy `OK once` / `OK always` / `REJECT` grammar too
- ✨ **Skills** — create, edit, and delete skills
- 👥 **Contacts** — manage per-user permissions
- 📋 **Audit** — full owner action history

Log in with `OWNER_UI_SECRET`.

## 📦 Runtime Image

The agent image (`node:24-bookworm-slim`) bundles provider-neutral batteries: 🟢 Node, 🐍 Python with the core data stack, and common shell/file utilities. Shared tooling lives under `workspace/runtime/` and persists across restarts — install extra CLIs on demand with the `install-tool` skill.

## 🧩 Skills

Skills are copied from `skills/` into `workspace/catalog/skills/` on startup. Manual edits inside `workspace/catalog/skills/` are overwritten on restart. You can also create or remove skills from the owner console.

## 🛠️ Development

```bash
npm install          # 📥 install dependencies
npm run dev          # 🔁 API server (tsx watch)
npm run dev:web      # 🎨 Vite dev server with HMR (proxies /api + /events)
npm test             # ✅ run tests (vitest)
npm run lint         # 🔍 typecheck (tsc --noEmit)
npm run build        # 📦 build SPA + server → dist/ + web/dist
```

> 💡 For UI work, run `npm run dev` and `npm run dev:web` together and open the Vite URL. To just run Felix, `docker compose up -d` builds and serves everything.

## 📂 Project Layout

```
src/
├── core/        # ⚙️  ports · routing · decide-turn · schemas
├── adapters/    # 🔌 codex · opencode · claude-code · mattermost · discord · slack · whatsapp
├── slices/      # 🧱 sessions · events · approvals · contacts · skills · audit · usage
├── server/      # 🌐 HTTP API + static SPA + SSE
├── engine.ts    # 🧠 main dispatch loop
└── index.ts     # 🚀 composition root
web/             # 🖥️  React + Vite owner console
skills/          # 🧩 bundled skills shipped in the image
tests/           # 🧪 vitest unit tests
workspace/       # 💾 runtime sessions, catalog, approvals, indexes, projects, tools (git-ignored)
```

## 🔗 Related

- 🦊 **[felix-agent-custom-skills](https://github.com/frdteknikelektro/felix-agent-custom-skills)** — extra skills for Felix Agent

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| Setup wizard looks old or missing options after `git pull` | You're on the cached image — run `docker compose run --rm --build setup` |
| `docker compose up` doesn't pick up changes | Rebuild: `docker compose up -d --build` |
| Container can't write to `workspace/` | Set `UID`/`GID` to match your host user: `UID=$(id -u) GID=$(id -g) docker compose up -d` |
| Port 53318 already in use | Another copy is running — `docker compose down` first |
| "No such file" errors on `.env` | Run the setup wizard: `docker compose run --rm --build setup` |
