# Felix Agent Docker

Felix is a persistent thread/session agent that wraps the Codex CLI and routes messages from source adapters through skill-gated LLM turns.

Mattermost is the current source adapter. Each source thread maps to one persisted Felix session, and each session uses skills copied from disk into the runtime workspace.

```text
source thread -> Felix session -> Codex turn -> skill-gated response or permission request
```

## Project Layout

```text
src/
  core/          ports, routing, turn decisions, schemas
  adapters/      Codex harness and Mattermost source adapter
  slices/        sessions, events, approvals, contacts, skills, audit
  server/        owner console, health endpoint, API routes
  engine.ts      main dispatch loop
  index.ts       composition root and supervisor
  config.ts      env loading
tests/           Vitest unit tests
skills/          bundled skills shipped in the image
config/          local secrets, including config/.env
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

Image name convention:

```bash
docker build \
  --build-arg AGENT_UID=$(id -u) \
  --build-arg AGENT_GID=$(id -g) \
  -t felix-agent-docker .
```

Run with persistent workspace and secret env:

```bash
mkdir -p workspace

docker run -d \
  --name felix-agent-docker \
  -p 53318:3000 \
  -v $(pwd)/config/.env:/run/secrets/.env:ro \
  -v $(pwd)/workspace:/home/agent/workspace \
  felix-agent-docker:latest
```

Build the image with the same numeric UID/GID as the host user that owns the bind-mounted `workspace/` directory. That avoids permission mismatches inside the container.

Rebuild and relaunch:

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

Health and logs:

```bash
curl http://localhost:53318/healthz
docker logs felix-agent-docker
docker logs felix-agent-docker --since 10m
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

Runtime config is loaded from environment variables, `/run/secrets/.env`, and `config/.env`. In Docker, mount `config/.env` to `/run/secrets/.env` read-only.

Start from:

```bash
cp .env.example config/.env
```

Key variables:

| Variable | Required | Description |
|---|---:|---|
| `MATTERMOST_URL` | yes | Mattermost base URL |
| `MATTERMOST_TOKEN` | yes | Bot user token |
| `MATTERMOST_BOT_USER_ID` | yes | Bot Mattermost user ID |
| `MATTERMOST_OWNER_USER_ID` | yes | Owner user ID for permission requests |
| `OPENAI_API_KEY` | yes | Codex/OpenAI authentication |
| `OWNER_UI_SECRET` | yes | Owner console login secret |
| `WORKSPACE_DIR` | no | Defaults to `/home/agent/workspace` in Docker |
| `HEALTH_PORT` | no | Defaults to `3000` |
| `CODEX_MODEL` | no | Defaults to the image/runtime setting |

## Owner Console

The owner console and health endpoint share the app port.

Docker default:

```text
http://localhost:53318/
```

Local dev default:

```text
http://localhost:3000/
```

Log in with `OWNER_UI_SECRET`. The console exposes sessions, approvals, contacts, skills, and audit history.

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

`thread_key` is an opaque stable key produced by each source adapter. Mattermost uses `mattermost:<channel_id>:<root_post_id>`.

`projects/` is reserved for checked-out target repositories Felix can edit, commit, branch, review, and open PRs/MRs for through future GitHub or GitLab adapters.
