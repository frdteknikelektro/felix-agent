# Felix Agent Docker

Felix is a persistent thread/session agent that wraps Codex or Opencode LLM backends and routes messages from source adapters through skill-gated LLM turns.

Mattermost, Discord, and Slack are the current source adapters. Each source thread maps to one persisted Felix session, and each session uses skills copied from disk into the runtime workspace.

```text
source thread -> Felix session -> Codex turn -> skill-gated response or permission request
```

## Quick Start

```bash
./setup.sh              # creates .env and workspace/ (one-time)
# edit .env with your secrets
docker compose up -d    # builds & starts the agent
curl http://localhost:53318/healthz
```

## Install Without Cloning

Download the essentials and start with the pre-built image:

```bash
mkdir felix-agent && cd felix-agent
curl -O https://raw.githubusercontent.com/frdteknikelektro/felix-agent/main/docker-compose.image.yml
curl -O https://raw.githubusercontent.com/frdteknikelektro/felix-agent/main/.env.example
curl -O https://raw.githubusercontent.com/frdteknikelektro/felix-agent/main/setup.sh
chmod +x setup.sh
cp docker-compose.image.yml docker-compose.yml
./setup.sh
# edit .env with your secrets, then:
UID=$(id -u) GID=$(id -g) docker compose up -d
```

The `docker-compose.image.yml` pulls the pre-built image from Docker Hub instead of building locally.

## Project Layout

```text
src/
  core/          ports, routing, turn decisions, schemas
  adapters/      Codex & Opencode harnesses; Mattermost, Discord & Slack adapters
  slices/        sessions, events, approvals, contacts, skills, audit
  server/        owner console, health endpoint, API routes
  engine.ts      main dispatch loop
  index.ts       composition root and supervisor
  config.ts      env loading
tests/           Vitest unit tests
skills/          bundled skills shipped in the image
.env             local secrets (git-ignored)
workspace/       runtime data, copied skills, sessions, approvals, contacts
```

`skills/` is the source of bundled skills. On startup, Felix copies those skills into `workspace/catalog/skills`, then loads the runtime catalog. Manual edits inside `workspace/catalog/skills` are overwritten on restart.

## Development

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
npm start
```

## Docker

### docker-compose (recommended)

```bash
./setup.sh                                # one-time bootstrap
UID=$(id -u) GID=$(id -g) \
  docker compose up -d                    # build & start
docker compose logs -f                    # follow logs
docker compose ps                         # check status
curl http://localhost:53318/healthz       # verify
```

To use the pre-built Docker Hub image instead of building locally, swap the compose file:

```bash
cp docker-compose.image.yml docker-compose.yml
# edit the image: field with your Docker Hub repo
UID=$(id -u) GID=$(id -g) docker compose up -d
```

Set `UID` / `GID` to match your host user so the mounted `workspace/` has correct permissions. On macOS with Docker Desktop the defaults (1000:1000) usually work.

To update to a new source version:

```bash
git pull
docker compose up -d --build
```

### docker run (manual)

```bash
docker build -t felix-agent .

docker run -d \
  --name felix-agent \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 53318:3000 \
  -v $(pwd)/.env:/run/secrets/.env:ro \
  -v $(pwd)/workspace:/home/node/workspace \
  felix-agent:latest
```

## Agent Runtime Image

The Docker image is a batteries-included Agent runtime image for provider-neutral skill work. The stable contract is expressed as Runtime capabilities; exact Runtime packages are implementation details.

Guaranteed v1 Runtime capabilities:

- Node execution.
- Python execution with `pip` and `venv` support.
- Core data stack for reporting and chart generation.
- Basic image and PDF utility work.
- Shell, network, archive, and compression utilities.
- Git/project editing basics.
- Shared runtime tooling paths under `workspace/runtime/`.

Current Runtime package baseline:

```text
build-essential ca-certificates curl dumb-init ghostscript git imagemagick jq
poppler-utils python3 python3-dev python3-pip python3-venv unzip zip
```

Current Core data stack installed during image build:

```text
numpy pandas matplotlib seaborn pillow requests openpyxl xlsxwriter python-dateutil
```

Provider-specific operational CLIs are intentionally not included in the image. Examples: `aws`, `gcloud`, `kubectl`, and `terraform`. Install those through `install-tool` or another explicit skill setup path when needed.

LibreOffice and browser automation runtimes are also excluded from v1.

## Config

Runtime config is loaded from environment variables and `/run/secrets/.env` (mounted read-only).

Start from:

```bash
cp .env.example .env
```

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

## Owner Console

The owner console shares port 3000 (mapped to 53318 by docker-compose). Log in with `OWNER_UI_SECRET`.

```text
http://localhost:53318/
```

The console exposes sessions, approvals, contacts, skills, and audit history.

## Workspace Layout

```text
workspace/
  intake/<source>/raw/
  records/sessions/<source>/<session-record>/
  records/approvals/
  records/audit.jsonl
  catalog/skills/
  catalog/contacts/
  runtime/bin/
  runtime/tools/
  runtime/python/
  runtime/health/
  index/thread-key/<source>/
  projects/<provider>/<namespace>/<repo>/
```

`thread_key` is an opaque stable key produced by each source adapter. Mattermost uses `mattermost:<channel_id>:<root_post_id>`, Discord uses `discord:<channel_id>:<root_message_id>`, Slack uses `slack:<channel_id>:<timestamp>`.

`projects/` is reserved for checked-out target repositories Felix can edit, commit, branch, review, and open PRs/MRs for through future GitHub or GitLab adapters.
