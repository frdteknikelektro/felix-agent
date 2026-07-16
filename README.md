# 🦊 Felix Agent

A persistent AI agent that wraps an LLM backend (Codex, OpenCode, or Claude Code) and routes messages from Mattermost, Discord, Slack, WhatsApp, or Telegram through skill-gated turns.

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

# Step 3 — Start Felix in the background (loopback-only by default)
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
The first setup prompt asks for the agent name; it is stored as `FELIX_NAME` and defaults to `Felix`.
Platform bot identities are discovered from authenticated APIs or paired-account state and are never written back to `.env`. Legacy Mattermost, Discord, and Slack identity variables remain accepted only as migration fallbacks; Telegram requires `getMe` and treats its legacy bot identity variable as parse-only. Owner setup accepts familiar inputs while storing only stable authorization identifiers: Mattermost resolves `@username`, Discord and Slack use one-time private-message claims, WhatsApp normalizes an international phone number into a JID, and Telegram uses its existing private claim. Existing owner IDs are preserved by default, and manual ID entry appears only after automatic discovery fails.

| Variable | Purpose |
|---|---|
| 🪪 `FELIX_NAME` | Default agent name shown to users |
| 🔑 `OWNER_UI_SECRET` | Owner console login |
| 🔒 `OWNER_UI_SECURE_COOKIE` | Set `true` when the owner console is served through an HTTPS reverse proxy |
| 🤖 `HARNESS` | `codex`, `opencode`, or `claude-code` |
| 🧠 `OPENAI_API_KEY` | Required when `HARNESS=codex` (or use OAuth) |
| 🧠 `OPENCODE_API_KEY` | Required when `HARNESS=opencode` |
| 🧠 `ANTHROPIC_API_KEY` | Required when `HARNESS=claude-code` |
| 🔀 `NINEROUTER_ENABLED` | Optional override that routes the active harness through 9router |
| 💬 `MATTERMOST_BOT_TOKEN` | Enables Mattermost; identity comes from `/api/v4/users/me` |
| 🎮 `DISCORD_BOT_TOKEN` | Enables Discord; identity comes from the logged-in client |
| 💼 `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Enables Slack; identity comes from `auth.test` |
| 📱 `WHATSAPP_BOT_ALIASES` | Optional comma-separated short aliases; the displayed name always uses `FELIX_NAME` |
| ✈️ `TELEGRAM_BOT_TOKEN` | Enables Telegram; identity comes from `getMe` |
| 🔁 `TELEGRAM_MODE` | `polling` (default) or `webhook` |
| 🌐 `TELEGRAM_WEBHOOK_URL` | Required for webhook mode; customer-managed HTTPS only |
| 🔐 `TELEGRAM_WEBHOOK_SECRET` | Required for externally reachable Telegram webhooks |
| 🟦 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client for the bundled Google Workspace skill |

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

> 🔒 **Security:** Secrets are injected via Docker secrets (not bind mounts). Runtime and setup containers drop all capabilities, prevent privilege escalation, and use a read-only root filesystem.

The setup container mounts the host configuration directory at `/config` and atomically creates `/config/.env`. Set `FELIX_SETUP_ENV_FILE` to override that destination; local setup defaults to the repository `.env`.

> 📦 Prefer a pre-built image? Swap in the published image:
> ```bash
> cp docker-compose.image.yml docker-compose.yml   # defaults to frdinawan/felix-agent:0.1.1
> docker compose --profile setup run --rm setup      # first-time setup from that same image
> docker compose up -d
> ```

Production deployments should pin the published image by digest after verifying
the `0.1.1` manifest. Set `FELIX_IMAGE=frdinawan/felix-agent@sha256:<digest>` to test or deploy an accepted candidate. The `latest` alias is not a production deployment target;
it is promoted manually only after release evidence is complete.

Replace the image reference with the verified immutable value:

```yaml
image: frdinawan/felix-agent@sha256:<verified-release-digest>
```

## 🖥️ Owner Console

```
http://127.0.0.1:53318/
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

Compose binds port `53318` to loopback. Remote console access and any public
Telegram or WhatsApp webhook require a customer-managed HTTPS reverse proxy,
firewall policy, and webhook secret. Set `OWNER_UI_SECURE_COOKIE=true` when the
console is served over HTTPS. Local WhatsApp operation remains backward
compatible by generating an internal webhook secret when no override is set.

## Supported integrations and data flows

Felix 0.1.1 supports five message sources (Mattermost, Discord, Slack,
WhatsApp, and Telegram), three harnesses (Codex, OpenCode, and Claude Code),
and the bundled Google Workspace skill through the pinned `gog` CLI. Messages,
attachments, and prompts are sent to the configured source and model providers;
Workspace state stays on the customer-managed filesystem volume. Felix owns no
telemetry service and sends no Felix-owned analytics.

Google authorized accounts and the file keyring persist under `GOG_HOME` in the
Workspace volume. OAuth credential templates are generated only in `/tmp`,
imported, and deleted. Restore requires the Workspace volume, `.env`,
`DB_ENCRYPTION_KEY`, `GOG_KEYRING_PASSWORD`, and Google keyring state.

## Backup, restore, upgrade, and rollback

Stop Felix before copying the complete `workspace/` directory and `.env` to a
protected backup. Include `DB_ENCRYPTION_KEY` and `GOG_KEYRING_PASSWORD` in a
separate protected secret backup:

```bash
docker compose stop felix
mkdir -p backups
tar --xattrs --acls -czf felix-workspace-$(date +%Y%m%d%H%M%S).tar.gz workspace
cp .env backups/felix.env
docker compose start felix
```

To restore on a fresh host:

```bash
docker compose down
tar --xattrs --acls -xzf felix-workspace-YYYYMMDDHHMMSS.tar.gz
cp backups/felix.env .env
UID=$(id -u) GID=$(id -g) docker compose up -d
```

Upgrade by backing up first, changing only the image tag or immutable digest,
and running `docker compose up -d`. Roll back by restoring the previous image
tag or digest with the same Workspace and environment. Never rotate
`DB_ENCRYPTION_KEY` or `GOG_KEYRING_PASSWORD` during an incident unless you
have a deliberate re-encryption plan.

Back up immediately before every upgrade and after material configuration or credential changes; choose an additional schedule that meets your recovery-point needs. Felix does not automatically expire Workspace records, messages, attachments, audit records, backups, or logs. Customers own retention, backup encryption, access controls, and secure deletion.

## Operations, logs, and support

Collect only the shortest log window needed to diagnose an issue. Redact tokens, OAuth URLs, authorization headers, cookies, prompts, customer messages, phone numbers, email addresses, attachment contents, and local paths before sharing. Never attach raw `.env`, Workspace data, or raw sensitive logs to a public issue. Felix has no Felix-owned telemetry.

Support is best effort through the project issue tracker and private vulnerability reporting described in `SECURITY.md`. There is no uptime, response-time, restoration-time, or resolution-time SLA.

The owner console remains loopback-only by default. Exposing Telegram or WhatsApp webhook routes requires a customer-managed HTTPS reverse proxy, firewall restrictions, rate controls, and configured webhook authentication. WhatsApp rejects every unsigned request, including when its source process is disabled or reconnecting.

Release vulnerability decisions are committed under `security/`. OpenVEX `not_affected` statements require exact package PURLs and matching, reviewed, unexpired evidence metadata; suppressions stay represented in the audit policy report. Exact `affected` statements record confirmed reachability and block high/critical findings; unresolved unfixable findings remain visible without being misclassified as proven reachable.

## 📦 Runtime Image

The agent image (`node:24-trixie-slim`, pinned by digest) bundles provider-neutral batteries: 🟢 Node, 🐍 Python with the core data stack, and common shell/file utilities. The base image receives a monthly dependency review and every update must pass the full audit, build, architecture, and clean-start smoke gate. Shared tooling lives under `workspace/runtime/` and persists across restarts — install extra CLIs on demand with the `install-tool` skill.

## 🧩 Skills

Skills are copied from `skills/` into `workspace/.agents/skills/` on startup. Manual edits inside `workspace/.agents/skills/` are overwritten on restart. You can also create or remove skills from the owner console.

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
├── adapters/    # 🔌 codex · opencode · claude-code · mattermost · discord · slack · whatsapp · telegram
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
