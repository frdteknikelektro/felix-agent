---
id: vercel
name: Vercel Management
description: Full Vercel platform management via the vercel CLI — deploy, domains, environment variables, projects, logs, rollback, aliases, DNS, SSL certificates, teams, and integrations. Uses VERCEL_TOKEN (available in environment). Uses text-based read/write permission guidance.
version: 1
enabled: true
kind: operational
permissions:
  - vercel.read
  - vercel.write
match:
  - vercel
  - deploy
  - deployment
  - domain
  - env var
  - environment variable
  - logs
  - rollback
  - promote
  - project
  - alias
  - dns
  - ssl
  - cert
  - certificate
  - team
  - integration
  - billing
---

# Vercel Management

## Purpose
Operate the Vercel platform through the `vercel` CLI. This skill covers deployment lifecycle, domain and DNS management, environment variables, project admin, log inspection, SSL certificates, team management, integrations, and billing.

Use text-based permission judgment. Do not add or rely on hardcoded TypeScript command detection for Vercel read/write classification.

## Permission Policy
Use the requested intent and the likely Vercel effect to choose the required permission:

- `vercel:vercel.read` — inspection, listing, viewing, pulling, and commands whose purpose is to observe existing state. Examples: `ls`, `list`, `inspect`, `logs`, `whoami`, `env ls`, `env pull`, `domains ls`, `domains inspect`, `certs ls`, `projects ls`, `alias ls`, `teams ls`, `dns ls`, `integration ls`, `integration-resource ls`, `billing ls`, `target ls`.
- `vercel:vercel.write` — deploy, create, add, remove, set, delete, promote, rollback, link, unlink, switch, verify, issue, buy, transfer, and any other operation that can change remote Vercel state.

If an operation is ambiguous, treat it as `vercel:vercel.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks for the specific destructive intent: `unlink`, `domains rm`, `projects rm`, `certs rm`, `env rm`, `alias rm`, `dns rm`, `integration rm`, `teams rm`, `rollback` to a specific deployment.

## Environment
Use tokens from the environment before every `vercel` CLI command. Do not use credential files.

Required variable:
- `VERCEL_TOKEN` — Vercel personal access token or team-scoped token

Command pattern:

```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
```

Verify the token is valid before any Vercel work:

```bash
test -n "$VERCEL_TOKEN" &&
export VERCEL_TOKEN="$VERCEL_TOKEN" &&
vercel whoami
```

If `vercel whoami` fails, check that `VERCEL_TOKEN` is set and valid. Never print the token value.

If the user wants team-scoped commands, include `--scope <team-slug>` in each command. Detect the team scope from `vercel teams ls` or user request. When a team is active, export the scope once:

```bash
export VERCEL_SCOPE="--scope <team-slug>"
```

## CLI Not Found
If a `vercel` command fails because the binary is missing (exit code 127, "command not found"), report it as a runtime error — not as a pre-check. Say: "The `vercel` CLI is not installed. Use `install-tool` to install it, then retry."

Do not pre-emptively check for the CLI. Do not gate the workflow on CLI presence. Let vercel commands fail naturally and handle the failure. The only gate in this skill is the permission gate.

## Operations
0. **Resolve permissions FIRST.** Before doing anything else — before checking CLI availability, before running any command — determine whether the user has permission for the requested work. If permission is missing, emit PERMISSION_REQUIRED. Never skip this step. Never run operational checks (CLI, token, env) before the permission gate.
1. Classify the requested work as read or write using the permission policy above.
2. export `VERCEL_TOKEN`, and verify with `vercel whoami` without exposing the token value. Determine active scope if needed.
3. Run direct `vercel` CLI commands. If the `vercel` binary is not found (exit code 127, "command not found"), tell the user to install it with `install-tool` and stop — do not retry.
4. For read tasks, return confirmed Vercel facts and include the relevant command summary.
5. For write tasks, perform only the requested change. For destructive work, proceed only when the user's request explicitly names the destructive intent.
6. Report command outcomes concisely, including the project name, deployment URL or ID, domain, env key names (values redacted), scope, and any Vercel errors.

## CLI Not Found
If a `vercel` command fails because the binary is missing, report it as a runtime error — not as a pre-check. Say: "The `vercel` CLI is not installed. Use `install-tool` to install it, then retry."

Do not pre-emptively check for the CLI. Do not gate the workflow on CLI presence. Let vercel commands fail naturally and handle the failure. The only gate in this skill is the permission gate.

## Operations

### Auth & Identity
Read-only (`vercel:vercel.read`):

```bash
vercel whoami
```

Returns the authenticated user or team. Use this to confirm the token works.

### Deployments

**List deployments** (`vercel:vercel.read`):

```bash
vercel ls [project-name] $VERCEL_SCOPE
vercel list [project-name] $VERCEL_SCOPE --prod
```

**Inspect a deployment** (`vercel:vercel.read`):

```bash
vercel inspect <deployment-url-or-id> $VERCEL_SCOPE
```

**Deploy** (`vercel:vercel.write`):

```bash
vercel $VERCEL_SCOPE
vercel deploy $VERCEL_SCOPE
vercel deploy --prod $VERCEL_SCOPE
vercel deploy --prebuilt $VERCEL_SCOPE
vercel deploy --archive=tgz $VERCEL_SCOPE
```

Options:
- `--prod` — promote immediately to production
- `--prebuilt` — skip build step, use prebuilt output
- `--archive=tgz` — deploy from a pre-packaged archive
- `--env KEY=value` — set env variable for this deployment only

**Rollback** (`vercel:vercel.write`):

```bash
vercel rollback [deployment-url-or-id] $VERCEL_SCOPE
vercel rollback --prod $VERCEL_SCOPE  # rollback production to previous
```

This is destructive. Only run when the user explicitly asks for a rollback. Confirm the target deployment before proceeding.

**Promote a deployment** (`vercel:vercel.write`):

```bash
vercel promote <deployment-url-or-id> $VERCEL_SCOPE
```

**View logs** (`vercel:vercel.read`):

```bash
vercel logs <deployment-url-or-id> $VERCEL_SCOPE
vercel logs <deployment-url-or-id> --follow $VERCEL_SCOPE
vercel logs <deployment-url-or-id> --since 1h $VERCEL_SCOPE
vercel logs <deployment-url-or-id> --until 2024-01-01T00:00:00Z $VERCEL_SCOPE
vercel logs <deployment-url-or-id> --json $VERCEL_SCOPE
vercel logs <deployment-url-or-id> --limit 100 $VERCEL_SCOPE
```

Limit log output to a reasonable number of lines (default 100). Use `--follow` only when the user explicitly asks to tail logs.

### Environment Variables

**List env vars** (`vercel:vercel.read`):

```bash
vercel env ls $VERCEL_SCOPE
vercel env ls <environment> $VERCEL_SCOPE  # production, preview, development
```

**Pull env vars** (`vercel:vercel.read`):

```bash
vercel env pull [file] $VERCEL_SCOPE
vercel env pull [file] --environment=<production|preview|development> $VERCEL_SCOPE
```

**Add an env var** (`vercel:vercel.write`):

```bash
vercel env add <key> <environment> $VERCEL_SCOPE
# Prompts for value. For non-interactive, use:
echo "<value>" | vercel env add <key> <environment> $VERCEL_SCOPE
```

Or use the `--yes` flag with stdin:

```bash
vercel env add <key> --environment=<production|preview|development> --yes $VERCEL_SCOPE <<< "<value>"
```

Never print env var values in replies. Refer to them by key name only.

**Remove an env var** (`vercel:vercel.write`):

```bash
vercel env rm <key> <environment> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### Domains

**List domains** (`vercel:vercel.read`):

```bash
vercel domains ls $VERCEL_SCOPE
vercel domains inspect <domain> $VERCEL_SCOPE
```

**Add a domain** (`vercel:vercel.write`):

```bash
vercel domains add <domain> $VERCEL_SCOPE
```

**Remove a domain** (`vercel:vercel.write`):

```bash
vercel domains rm <domain> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

**Buy a domain** (`vercel:vercel.write`):

```bash
vercel domains buy <domain> $VERCEL_SCOPE
```

**Move a domain** (`vercel:vercel.write`):

```bash
vercel domains move <domain> $VERCEL_SCOPE
```

**Transfer a domain in** (`vercel:vercel.write`):

```bash
vercel domains transfer-in <domain> $VERCEL_SCOPE
```

**Verify a domain** (`vercel:vercel.write`):

```bash
vercel domains verify <domain> $VERCEL_SCOPE
```

### DNS Records

**List DNS records** (`vercel:vercel.read`):

```bash
vercel dns ls <domain> $VERCEL_SCOPE
```

**Add a DNS record** (`vercel:vercel.write`):

```bash
vercel dns add <domain> <subdomain> <type> <value> $VERCEL_SCOPE
```

**Remove a DNS record** (`vercel:vercel.write`):

```bash
vercel dns rm <record-id> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### SSL Certificates

**List certificates** (`vercel:vercel.read`):

```bash
vercel certs ls $VERCEL_SCOPE
```

**Issue a certificate** (`vercel:vercel.write`):

```bash
vercel certs issue <cn> [domains...] $VERCEL_SCOPE
```

**Remove a certificate** (`vercel:vercel.write`):

```bash
vercel certs rm <cn> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### Projects

**List projects** (`vercel:vercel.read`):

```bash
vercel projects ls $VERCEL_SCOPE
```

**Add a project** (`vercel:vercel.write`):

```bash
vercel projects add <project-name> $VERCEL_SCOPE
```

**Remove a project** (`vercel:vercel.write`):

```bash
vercel projects rm <project-name> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### Project Linking

**Link current directory to a Vercel project** (`vercel:vercel.write`):

```bash
vercel link $VERCEL_SCOPE
```

**Unlink current directory** (`vercel:vercel.write`):

```bash
vercel unlink $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### Aliases

**List aliases** (`vercel:vercel.read`):

```bash
vercel alias ls $VERCEL_SCOPE
```

**Set an alias** (`vercel:vercel.write`):

```bash
vercel alias set <deployment-url> <alias> $VERCEL_SCOPE
```

**Remove an alias** (`vercel:vercel.write`):

```bash
vercel alias rm <alias> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

### Teams

**List teams** (`vercel:vercel.read`):

```bash
vercel teams ls
```

**Add a team** (`vercel:vercel.write`):

```bash
vercel teams add
```

**Remove a team** (destructive, `vercel:vercel.write`):

Only through the Vercel dashboard. The CLI does not support `teams rm`.

**Switch team scope** (`vercel:vercel.write`):

```bash
vercel switch <team-slug>
```

This changes the active scope for subsequent commands. Use `VERCEL_SCOPE` to scope individual commands instead.

### Integrations

**List integrations** (`vercel:vercel.read`):

```bash
vercel integration ls $VERCEL_SCOPE
```

**Add an integration** (`vercel:vercel.write`):

```bash
vercel integration add <name> $VERCEL_SCOPE
```

**Remove an integration** (`vercel:vercel.write`):

```bash
vercel integration rm <name> $VERCEL_SCOPE --yes
```

This is destructive. Only run when the user explicitly asks.

**List integration resources** (`vercel:vercel.read`):

```bash
vercel integration-resource ls $VERCEL_SCOPE
```

**Add integration resource** (`vercel:vercel.write`):

```bash
vercel integration-resource add <name> $VERCEL_SCOPE
```

**Remove integration resource** (`vercel:vercel.write`):

```bash
vercel integration-resource rm <name> $VERCEL_SCOPE --yes
```

### Billing

**View billing** (`vercel:vercel.read`):

```bash
vercel billing ls $VERCEL_SCOPE
```

**Add billing** (`vercel:vercel.write`):

```bash
vercel billing add $VERCEL_SCOPE
```

### Local Development

**Run local dev server** (`vercel:vercel.write`):

```bash
vercel dev $VERCEL_SCOPE
vercel dev --listen <port> $VERCEL_SCOPE
```

**Initialize a new Vercel project** (`vercel:vercel.write`):

```bash
vercel init [example-name] $VERCEL_SCOPE
```

### Targets

**List deployment targets** (`vercel:vercel.read`):

```bash
vercel target ls <project> $VERCEL_SCOPE
```

### Git Integration

**Connect a Git repository** (`vercel:vercel.write`):

```bash
vercel git connect <git-url> $VERCEL_SCOPE
```

**Disconnect Git** (`vercel:vercel.write`):

```bash
vercel git disconnect $VERCEL_SCOPE --yes
```

## Command Reference

### Global Flags
Apply these to any `vercel` command:

| Flag | Usage |
|---|---|
| `--scope <slug>` | Team or user scope |
| `--token <token>` | Override token (prefer env var) |
| `--cwd <path>` | Working directory |
| `--debug` | Verbose debug output |
| `-y, --yes` | Skip confirmation prompts |
| `--local-config <path>` | Path to local config file |
| `--global-config <path>` | Path to global config file |

### Output Flags
When the user wants structured output:

```bash
vercel ls --json $VERCEL_SCOPE
```

## Quick Examples
Every example includes the required env setup. Copy the full sequence.

### Deploy from scratch
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
# Verify
vercel whoami
# Link current directory to a Vercel project
vercel link
# Deploy to preview
vercel deploy
# Or deploy straight to production
vercel deploy --prod
```

### Deploy and promote to production alias
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel deploy --prod
```

### Add an environment variable
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel env add DATABASE_URL production
# When prompted, paste or pipe the value. Never echo it in the reply.
```

### Inspect a deployment and tail logs
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel inspect <deployment-url>
vercel logs <deployment-url> --limit 50
```

### Add a custom domain
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel domains add <domain>
vercel domains verify <domain>
```

### Rollback a production deployment
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel rollback --prod
```

### List all projects and their latest deployments
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel projects ls
```

### List environment variables for production
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel env ls production
```

### Build a workspace project without deploying
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
cd <project-directory>
vercel whoami
vercel link
vercel build --prod
```

### Deploy a workspace project (linked, with vercel.json)
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
cd <project-directory>
vercel whoami
vercel deploy --prod
```

### Set an alias to point a deployment to a domain
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel alias set <deployment-url> <alias-domain>
```

### Team-scoped deployment
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel deploy --scope <team-slug> --prod
```

### Pull env vars to local .env file
```bash
export VERCEL_TOKEN="$VERCEL_TOKEN"
vercel whoami
vercel env pull .env.local --environment=production
```

## Output
- Keep replies concise and operational.
- Include project name, deployment URL, domain, env key names (values redacted), and scope.
- When listing, use a compact format: one line per item.
- Report errors with the exact `vercel` command attempted and the error message.
- Separate confirmed Vercel facts from assumptions.
- If blocked by missing token, missing CLI, scope mismatch, or Vercel API errors, state the blocker and the smallest next step.
- Never print the `VERCEL_TOKEN` value, any env var values, or full signed request material.

## Checks
- Always export `VERCEL_TOKEN` before any Vercel command.
- Always verify the token with `vercel whoami` before doing real work.
- Never print credential values, token, or env var values.
- If the `vercel` CLI binary is missing, tell the user to use `install-tool` first.
- If an operation is ambiguous, treat it as write.
- Destructive operations must be explicitly requested by the user before proceeding.
- When the user mentions a specific team, include `--scope <team-slug>`.
- For non-interactive environments (CI), always use `--yes` flag to skip prompts.
- Tokens are in the environment

## Cross-skill convention
Other skills that need Vercel deployment or inspection should not embed their own Vercel commands. Route Vercel work through this skill.
