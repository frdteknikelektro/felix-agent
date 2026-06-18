---
id: github-jala
name: GitHub Jala Management
description: Jala-specific GitHub account management. Extends the base github skill — all operations, permission policy, destructive gating, and CLI checks are identical. The only difference is the credential: GITHUB_JALA_TOKEN (available in environment) replaces GITHUB_TOKEN.
version: 1
enabled: true
kind: operational
permissions:
  - github.read
  - github.review
  - github.write
match:
  - github jala
  - jala github
  - jala repo
  - jala issue
  - jala pr
  - jala release
  - jala workflow
  - jala actions
  - jala secret
  - jala gist
  - atnic
  - jalaproduct
---

# GitHub Jala Management

## Purpose
Operate Jala's GitHub account (user `jalaproduct`, org `Atnic`) through the `gh` CLI. This skill extends the base `github` skill. Every operation, permission policy, destructive-operation gate, CLI availability check, and command reference is identical — read `skills/github/SKILL.md` for the full reference. This skill only overrides the credential contract and the default organization context.

**Default org**: All Jala repositories live under the `Atnic` GitHub organization. When no specific owner is provided, default to `Atnic`. For repo-scoped operations, use `--repo Atnic/<repo-name>`. To list all Jala repos, use `gh repo list Atnic`.

Do not duplicate operation documentation. If you need the full command reference for a GitHub operation, read the base `github` SKILL.md. This file documents only what is different.

## Permission Policy
Same text-based read/write split as the base `github` skill, namespaced under `github-jala`:

- `github-jala:github.read` — inspection, listing, viewing, searching, downloading (same scope as base).
- `github-jala:github.review` — adding comments, approving pull requests, merging pull requests, and other collaborative review actions (same scope as base).
- `github-jala:github.write` — create, edit, close, reopen, fork, archive, rename, delete, rerun, cancel, set (same scope as base).

If an operation is ambiguous, treat it as `github-jala:github.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks — same gating as the base skill.

## Environment (overrides base)
Tokens are in the environment. The Jala account uses its own token:

- `GITHUB_JALA_TOKEN` — Jala-specific GitHub personal access token

Command pattern:

```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
```

Verify:

```bash
test -n "$GITHUB_JALA_TOKEN" &&
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN" &&
gh auth status
```

Note: the `gh` CLI reads `GITHUB_TOKEN` (and falls back to `GH_TOKEN`). The Jala value is mapped in: `GITHUB_TOKEN="$GITHUB_JALA_TOKEN"`. Never print the token value.

## Permissions FIRST
Before doing anything else — before checking CLI availability, before running any command — resolve permissions. If permission is missing, emit PERMISSION_REQUIRED. Never skip this. The only gate in this skill is the permission gate.

## CLI Not Found
If a `gh` command fails because the binary is missing, report it as a runtime error. Say: "The `gh` CLI is not installed. Use `install-tool` to install it, then retry." Do not pre-emptively check for the CLI.

## Operations
All operations are identical to the base `github` skill. Read `skills/github/SKILL.md` for the full operation reference covering Repositories, Issues, Pull Requests, Releases, Actions/Workflows, Secrets & Variables, Gists, Search, and API Access.

Every command must be preceded by using `GITHUB_TOKEN="$GITHUB_JALA_TOKEN"`.

For local operations (clone, edit, PRs), use the project workspace directory (`workspace/projects/<owner>/<repo>/`) exactly as documented in the base github skill. Always `cd` into the repo directory before running git or repo-local gh commands.

## Quick Examples
Every example maps `GITHUB_JALA_TOKEN` to `GITHUB_TOKEN`.

### List Jala repositories
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh repo list Atnic --limit 50
```

### View a Jala repository
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh repo view Atnic/jala-web-next --json name,description,url,defaultBranchRef
```

### Create a Jala repository
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh repo create Atnic/new-service --private --description "New Jala microservice"
```

### List Jala issues
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh issue list --repo Atnic/jala-web-next --state open --limit 20
```

### Create a Jala pull request
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh pr create --repo Atnic/jala-web-next --title "Fix API timeout" --body "Increases timeout to 30s" --base main --head fix-timeout
```

### Set a Jala repository secret
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh secret set DATABASE_URL --repo Atnic/jala-web-next --body "<secret-value>"
```

### Create a Jala release
```bash
export GITHUB_TOKEN="$GITHUB_JALA_TOKEN"
gh auth status
gh release create v1.2.0 --repo Atnic/jala-web-next --title "v1.2.0" --generate-notes
```

## Output
Same as base `github` skill. Keep replies concise and operational. Include repo name, issue/PR number, release tag, workflow name, and relevant identifiers. Never print the `GITHUB_JALA_TOKEN` value, secret values, or full signed request material.

## Checks
- Always export `GITHUB_TOKEN="$GITHUB_JALA_TOKEN"` before any GitHub command.
- Always verify the token with `gh auth status` before doing real work.
- Never print `GITHUB_JALA_TOKEN`, `GITHUB_TOKEN`, or any secret values.
- Read `skills/github/SKILL.md` for any operation not documented here.
- If the `gh` CLI binary is missing, tell the user to use `install-tool` first.
- Destructive operations must be explicitly requested by the user before proceeding.
- Tokens are in the environment
