# 🦊 Felix Agent

A persistent AI agent that wraps an LLM backend (Codex, OpenCode, or Claude Code) and routes messages from Mattermost, Discord, or Slack through skill-gated turns.

> 🦊 Felix runs as a Docker container with a live owner console for monitoring sessions, approving skills, and managing contacts.

```
💬 source thread → 🧵 Felix session → 🤖 LLM turn → 🛡️ skill-gated reply
```

## 🚀 Quick Start

```bash
# 📥 Clone
git clone https://github.com/frdteknikelektro/felix-agent.git
cd felix-agent

# ⚙️ One-time setup
npm install && npm run setup

# 🐳 Build & start
docker compose up -d

# ❤️ Check health
curl http://localhost:53318/healthz
```

> 🖥️ Open the owner console at **http://localhost:53318** and log in with `OWNER_UI_SECRET`.

## ⚙️ Configure

Run `npm run setup` to configure your `.env` interactively. Re-run anytime to update harness, sources, or the owner channel.

| Variable | Purpose |
|---|---|
| 🔑 `OWNER_UI_SECRET` | Owner console login |
| 🤖 `HARNESS` | `codex`, `opencode`, or `claude-code` |
| 🧠 `OPENAI_API_KEY` | Required when `HARNESS=codex` |
| 🧠 `OPENCODE_API_KEY` | Required when `HARNESS=opencode` |
| 🧠 `ANTHROPIC_API_KEY` | Required when `HARNESS=claude-code` |
| 💬 `MATTERMOST_TOKEN` | Enables Mattermost |
| 🎮 `DISCORD_TOKEN` | Enables Discord |
| 💼 `SLACK_TOKEN` | Enables Slack |

> 💡 See `.env.example` for all defaults.

## 🐳 Docker

```bash
# 🔧 Set UID/GID to match the host user that owns workspace/ (defaults 1000:1000)
UID=$(id -u) GID=$(id -g) docker compose up -d   # Unix / WSL
docker compose up -d                              # Windows Docker Desktop

# 📜 Manage
docker compose logs -f
docker compose ps
docker compose up -d --build   # 🔁 rebuild on source changes
```

> 📦 Prefer a pre-built image? Skip the local build:
> ```bash
> cp docker-compose.image.yml docker-compose.yml   # uses frdinawan/felix-agent:latest
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
├── adapters/    # 🔌 codex · opencode · claude-code · mattermost · discord · slack
├── slices/      # 🧱 sessions · events · approvals · contacts · skills · audit
├── server/      # 🌐 HTTP API + static SPA + SSE
├── engine.ts    # 🧠 main dispatch loop
└── index.ts     # 🚀 composition root
web/             # 🖥️  React + Vite owner console
skills/          # 🧩 bundled skills shipped in the image
tests/           # 🧪 vitest unit tests
workspace/       # 💾 runtime data (git-ignored)
```

## 🔗 Related

- 🦊 **[felix-agent-custom-skills](https://github.com/frdteknikelektro/felix-agent-custom-skills)** — extra skills for Felix Agent
