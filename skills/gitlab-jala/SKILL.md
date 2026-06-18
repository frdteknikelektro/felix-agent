---
id: gitlab-jala
name: GitLab Jala Management
description: Jala-specific GitLab account management. Extends the base gitlab skill — all operations, permission policy, destructive gating, and CLI checks are identical. The only difference is the credential: GITLAB_JALA_TOKEN (available in environment) replaces GITLAB_TOKEN.
version: 1
enabled: true
kind: operational
permissions:
  - gitlab.read
  - gitlab.review
  - gitlab.write
match:
  - gitlab jala
  - jala gitlab
  - jala glab
  - jala merge request
  - jala mr
  - jala pipeline
  - atnic
  - atnic gitlab
---

# GitLab Jala Management

## Purpose
Operate Jala's GitLab account (group: `atnic`) through the `glab` CLI. This skill extends the base `gitlab` skill. Every operation, permission policy, destructive-operation gate, CLI availability check, and command reference is identical — read `skills/gitlab/SKILL.md` for the full reference. This skill only overrides the credential contract and the default group context.

**Default group**: All Jala repositories live under the `atnic` GitLab group. When no specific namespace is provided, default to `atnic`. For repo-scoped operations, use `--repo atnic/<project-name>`. To list all Jala repos, use `glab repo list --group atnic`.

Do not duplicate operation documentation. If you need the full command reference for a GitLab operation, read the base `gitlab` SKILL.md. This file documents only what is different.

## Permission Policy
Same text-based read/write split as the base `gitlab` skill, namespaced under `gitlab-jala`:

- `gitlab-jala:gitlab.read` — inspection, listing, viewing, searching, downloading (same scope as base).
- `gitlab-jala:gitlab.review` — adding comments, approving and merging merge requests, and other collaborative review actions (same scope as base).
- `gitlab-jala:gitlab.write` — create, edit, close, reopen, fork, archive, delete, retry, cancel, set (same scope as base).

If an operation is ambiguous, treat it as `gitlab-jala:gitlab.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks — same gating as the base skill.

## Environment (overrides base)
Tokens are in the environment. The Jala account uses its own token:

- `GITLAB_JALA_TOKEN` — Jala-specific GitLab personal access token

Command pattern:

```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
```

Verify:

```bash
test -n "$GITLAB_JALA_TOKEN" &&
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN" &&
glab auth status
```

Note: the `glab` CLI reads `GITLAB_TOKEN` from the environment. The Jala value is mapped in: `GITLAB_TOKEN="$GITLAB_JALA_TOKEN"`. Never print the token value.

## Permissions FIRST
Before doing anything else — before checking CLI availability, before running any command — resolve permissions. If permission is missing, emit PERMISSION_REQUIRED. Never skip this. The only gate in this skill is the permission gate.

## CLI Not Found
If a `glab` command fails because the binary is missing, report it as a runtime error. Say: "The `glab` CLI is not installed. Use `install-tool` to install it, then retry." Do not pre-emptively check for the CLI.

## Operations
All operations are identical to the base `gitlab` skill. Read `skills/gitlab/SKILL.md` for the full operation reference covering Repositories, Issues, Merge Requests, Releases, Pipelines/CI/CD, Variables, Snippets, and API Access.

Every command must be preceded by using `GITLAB_TOKEN="$GITLAB_JALA_TOKEN"`.

For local operations (clone, edit, MRs), use the project workspace directory (`workspace/projects/<namespace>/<project>/`) exactly as documented in the base gitlab skill. Always `cd` into the project directory before running git or project-local glab commands.

## Quick Examples
Every example maps `GITLAB_JALA_TOKEN` to `GITLAB_TOKEN`.

### List Jala repositories
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab repo list --group atnic --all
```

### View a Jala repository
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab repo view atnic/core --output json
```

### Create a Jala repository
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab repo create --name new-service --private --description "New Jala microservice" --group atnic
```

### List Jala issues
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab issue list --repo atnic/core --state opened --per-page 20
```

### Create a Jala merge request
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab mr create --repo atnic/core --title "Fix API timeout" --description "Increases timeout to 30s" --target-branch main --source-branch fix-timeout
```

### Set a Jala CI/CD variable
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab variable set DATABASE_URL --repo atnic/infra --value "<secret-value>" --masked
```

### Create a Jala release
```bash
export GITLAB_TOKEN="$GITLAB_JALA_TOKEN"
glab auth status
glab release create v1.2.0 --repo atnic/core --name "v1.2.0" --notes "Bug fixes and improvements"
```

## Output
Same as base `gitlab` skill. Keep replies concise and operational. Include project path, issue/MR number, release tag, pipeline ID, and relevant identifiers. Never print the `GITLAB_JALA_TOKEN` value, variable values, or full token material.

## Checks
- Always export `GITLAB_TOKEN="$GITLAB_JALA_TOKEN"` before any GitLab command.
- Always verify the token with `glab auth status` before doing real work.
- Never print `GITLAB_JALA_TOKEN`, `GITLAB_TOKEN`, or any variable values.
- Read `skills/gitlab/SKILL.md` for any operation not documented here.
- If the `glab` CLI binary is missing, tell the user to use `install-tool` first.
- Destructive operations must be explicitly requested by the user before proceeding.
- Tokens are in the environment
