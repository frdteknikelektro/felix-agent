---
id: vercel-jala
name: Vercel Jala Management
description: Jala-specific Vercel account management. Extends the base vercel skill — all operations, permission policy, destructive gating, and CLI checks are identical. The only difference is the credential: VERCEL_JALA_TOKEN (available in environment) replaces VERCEL_TOKEN.
version: 1
enabled: true
kind: operational
permissions:
  - vercel.read
  - vercel.write
match:
  - vercel jala
  - jala vercel
  - jala deploy
  - jala domain
  - jala env
  - jala logs
  - jala rollback
  - jala project
  - jala alias
---

# Vercel Jala Management

## Purpose
Operate Jala's separate Vercel account through the `vercel` CLI. This skill extends the base `vercel` skill. Every operation, permission policy, destructive-operation gate, CLI availability check, and command reference is identical — read `skills/vercel/SKILL.md` for the full reference. This skill only overrides the credential contract and team/scope defaults.

Do not duplicate operation documentation. If you need the full command reference for a Vercel operation, read the base `vercel` SKILL.md. This file documents only what is different.

## Permission Policy
Same text-based read/write split as the base `vercel` skill, namespaced under `vercel-jala`:

- `vercel-jala:vercel.read` — inspection, listing, viewing, pulling (same scope as base).
- `vercel-jala:vercel.write` — deploy, create, add, remove, set, delete, promote, rollback, link, unlink (same scope as base).

If an operation is ambiguous, treat it as `vercel-jala:vercel.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks — same gating as the base skill.

## Environment (overrides base)
Tokens are in the environment. The Jala account uses its own token:

- `VERCEL_JALA_TOKEN` — Jala-specific Vercel personal access token or team-scoped token

Command pattern:

```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
```

Verify:

```bash
test -n "$VERCEL_JALA_TOKEN" &&
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN" &&
vercel whoami
```

Note: the `vercel` CLI reads `VERCEL_TOKEN`. The Jala value is mapped in: `VERCEL_TOKEN="$VERCEL_JALA_TOKEN"`. Never print the token value.

If the Jala account has a default team, scope commands:

```bash
export VERCEL_SCOPE="--scope <jala-team-slug>"
```

## Permissions FIRST
Before doing anything else — before checking CLI availability, before running any command — resolve permissions. If permission is missing, emit PERMISSION_REQUIRED. Never skip this. The only gate in this skill is the permission gate.

## CLI Not Found
If a `vercel` command fails because the binary is missing, report it as a runtime error. Say: "The `vercel` CLI is not installed. Use `install-tool` to install it, then retry." Do not pre-emptively check for the CLI.

## Operations
All operations are identical to the base `vercel` skill. Read `skills/vercel/SKILL.md` for the full operation reference covering Deployments, Environment Variables, Domains, DNS, SSL Certificates, Projects, Aliases, Teams, Integrations, Billing, Local Development, Git Integration, and Targets.

Every command must be preceded by using `VERCEL_TOKEN="$VERCEL_JALA_TOKEN"`.

## Quick Examples
Every example maps `VERCEL_JALA_TOKEN` to `VERCEL_TOKEN`.

### Deploy a Jala project
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel deploy --prod
```

### List Jala environment variables
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel env ls production
```

### Add a Jala environment variable
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel env add DATABASE_URL production
```

### Inspect a Jala deployment
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel inspect <deployment-url>
vercel logs <deployment-url> --limit 50
```

### Add a custom domain to a Jala project
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel domains add <domain>
```

### Rollback a Jala production deployment
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel rollback --prod
```

### List all Jala projects
```bash
export VERCEL_TOKEN="$VERCEL_JALA_TOKEN"
vercel whoami
vercel projects ls
```

## Output
Same as base `vercel` skill. Keep replies concise and operational. Include project name, deployment URL, domain, env key names (values redacted), and scope. Never print the `VERCEL_JALA_TOKEN` value, any env var values, or full signed request material.

## Checks
- Always export `VERCEL_TOKEN="$VERCEL_JALA_TOKEN"` before any Vercel command.
- Always verify the token with `vercel whoami` before doing real work.
- Never print `VERCEL_JALA_TOKEN`, `VERCEL_TOKEN`, or any env var values.
- Read `skills/vercel/SKILL.md` for any operation not documented here.
- If the `vercel` CLI binary is missing, tell the user to use `install-tool` first.
- Destructive operations must be explicitly requested by the user before proceeding.
- Tokens are in the environment
