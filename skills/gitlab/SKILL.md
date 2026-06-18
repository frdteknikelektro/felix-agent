---
id: gitlab
name: GitLab Management
description: Full GitLab management via the glab CLI — repos, issues, merge requests, releases, pipelines, variables, snippets, API, and auth. Uses GITLAB_TOKEN (available in environment). Uses text-based read/write permission guidance.
version: 1
enabled: true
kind: operational
permissions:
  - gitlab.read
  - gitlab.review
  - gitlab.write
match:
  - gitlab
  - glab
  - merge request
  - mr
  - pipeline
  - ci/cd
  - snippet
  - gitlab ci
  - gitlab variable
---

# GitLab Management

## Purpose
Operate GitLab through the `glab` CLI. This skill covers repository management, issues, merge requests, releases, CI/CD pipelines, variables, snippets, and API access. Defaults to gitlab.com.

Use text-based permission judgment. Do not add or rely on hardcoded TypeScript command detection for GitLab read/write classification.

## Permission Policy
Use the requested intent and the likely GitLab effect to choose the required permission:

- `gitlab:gitlab.read` — inspection, listing, viewing, searching, downloading, and commands whose purpose is to observe existing state. Examples: `repo list`, `repo view`, `issue list`, `issue view`, `mr list`, `mr view`, `mr diff`, `mr approvers`, `release list`, `release view`, `release download`, `ci list`, `ci view`, `ci trace`, `ci status`, `variable list`, `snippet list`, `snippet view`, `auth status`, `api GET`.
- `gitlab:gitlab.review` — adding comments, approving and merging merge requests, and other collaborative review actions that do not create, edit, or delete GitLab resources. Examples: `issue note`, `mr note`, `mr approve`, `mr approve --sha`, `mr merge`, `mr merge --squash`, `mr merge --delete-source-branch`.
- `gitlab:gitlab.write` — create, edit, close, reopen, fork, archive, delete, retry, cancel, set, and any other operation that can change remote GitLab state.

If an operation is ambiguous, treat it as `gitlab:gitlab.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks for the specific destructive intent: `repo delete`, `release delete`, `variable delete`, `snippet delete`, `mr close` without merge, merging conflicting MRs.

## Environment
Use tokens from the environment before every `glab` CLI command. Do not use credential files.

Required variable:
- `GITLAB_TOKEN` — GitLab personal access token with `api`, `read_user`, `read_repository`, `write_repository` scopes

Command pattern:

```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
```

Verify the token is valid before any GitLab work:

```bash
test -n "$GITLAB_TOKEN" &&
export GITLAB_TOKEN="$GITLAB_TOKEN" &&
glab auth status
```

If `glab auth status` fails, check that `GITLAB_TOKEN` is set and valid. Never print the token value.

For self-managed GitLab instances (non-gitlab.com), export the host:

```bash
export GITLAB_HOST="gitlab.example.com"
```

## CLI Not Found
If a `glab` command fails because the binary is missing (exit code 127, "command not found"), report it as a runtime error — not as a pre-check. Say: "The `glab` CLI is not installed. Use `install-tool` to install it, then retry."

Do not pre-emptively check for the CLI. Do not gate the workflow on CLI presence. Let glab commands fail naturally and handle the failure. The only gate in this skill is the permission gate.

## Workflow
0. **Resolve permissions FIRST.** Before doing anything else — before checking CLI availability, before running any command — determine whether the user has permission for the requested work. If permission is missing, emit PERMISSION_REQUIRED. Never skip this step. Never run operational checks (CLI, token, env) before the permission gate.
1. Classify the requested work as read or write using the permission policy above.
2. export `GITLAB_TOKEN`, and verify with `glab auth status` without exposing the token value. Determine the target project/group with `glab repo list` if needed.
3. Run direct `glab` CLI commands. If the `glab` binary is not found (exit code 127, "command not found"), tell the user to install it with `install-tool` and stop — do not retry.
4. For read tasks, return confirmed GitLab facts and include the relevant command summary.
5. For write tasks, perform only the requested change. For destructive work, proceed only when the user's request explicitly names the destructive intent.
6. Report command outcomes concisely, including the project path, issue/MR number or URL, release tag, pipeline ID, variable key (values redacted), and any GitLab errors.

## Operations

### Auth & Identity
Read-only (`gitlab:gitlab.read`):

```bash
glab auth status
glab auth status --hostname <gitlab-host>
```

Returns authentication state. Use this to confirm the token works.

**Pull Current User** (`gitlab:gitlab.read`):

```bash
glab api user
glab api user --jq '.username'
```

### Repositories

**List repositories** (`gitlab:gitlab.read`):

```bash
glab repo list
glab repo list --all
glab repo list --page 1 --per-page 50
glab repo list --owned
glab repo list --starred
glab repo list --search <keyword>
glab repo list --group <group-path>
```

**View a repository** (`gitlab:gitlab.read`):

```bash
glab repo view <namespace/project>
glab repo view <namespace/project> --web
glab repo view <namespace/project> --output json
```

**Clone a repository** (`gitlab:gitlab.write`):

```bash
glab repo clone <namespace/project>
glab repo clone <namespace/project> --dir <target-dir>
```

**Create a repository** (`gitlab:gitlab.write`):

```bash
glab repo create
glab repo create --name <name>
glab repo create --name <name> --description "<desc>"
glab repo create --name <name> --public
glab repo create --name <name> --internal
glab repo create --name <name> --private
glab repo create --name <name> --group <group-path>
```

**Fork a repository** (`gitlab:gitlab.write`):

```bash
glab repo fork <namespace/project>
glab repo fork <namespace/project> --clone
glab repo fork <namespace/project> --remote
```

**Archive a repository** (`gitlab:gitlab.write`):

```bash
glab repo archive <namespace/project>
```

**Delete a repository** (`gitlab:gitlab.write`):

```bash
glab repo delete <namespace/project> --yes
```

This is destructive. Only run when the user explicitly asks.

### Issues

**List issues** (`gitlab:gitlab.read`):

```bash
glab issue list
glab issue list --repo <namespace/project>
glab issue list --assignee @me
glab issue list --label "<label>"
glab issue list --state opened
glab issue list --state closed
glab issue list --iteration current
glab issue list --per-page 50
glab issue list --search "<query>"
glab issue list --output json
```

**View an issue** (`gitlab:gitlab.read`):

```bash
glab issue view <number>
glab issue view <number> --repo <namespace/project>
glab issue view <number> --comments
glab issue view <number> --web
glab issue view <number> --output json
```

**Search issues** (`gitlab:gitlab.read`):

```bash
glab issue list --search "<keyword>"
glab api search --field scope=issues --field search="<query>"
```

**Create an issue** (`gitlab:gitlab.write`):

```bash
glab issue create
glab issue create --title "<title>" --description "<body>"
glab issue create --title "<title>" --description "<body>" --repo <namespace/project>
glab issue create --title "<title>" --description "<body>" --assignee <user>
glab issue create --title "<title>" --description "<body>" --label "<label>"
glab issue create --title "<title>" --description "<body>" --milestone "<milestone>"
glab issue create --title "<title>" --description "<body>" --weight 3
```

Use GitLab Flavored Markdown in descriptions: task lists (`- [ ]`), tables, code blocks, etc.

**Close/Reopen an issue** (`gitlab:gitlab.write`):

```bash
glab issue close <number>
glab issue close <number> --repo <namespace/project>
glab issue reopen <number>
```

**Add a comment to an issue** (`gitlab:gitlab.review`):

```bash
glab issue note <number> --message "<comment>"
```

### Merge Requests

**List merge requests** (`gitlab:gitlab.read`):

```bash
glab mr list
glab mr list --repo <namespace/project>
glab mr list --assignee @me
glab mr list --reviewer @me
glab mr list --author @me
glab mr list --label "<label>"
glab mr list --state opened
glab mr list --state closed
glab mr list --state merged
glab mr list --target-branch <branch>
glab mr list --source-branch <branch>
glab mr list --search "<keyword>"
glab mr list --per-page 50
glab mr list --output json
```

**View a merge request** (`gitlab:gitlab.read`):

```bash
glab mr view <number>
glab mr view <number> --repo <namespace/project>
glab mr view <number> --comments
glab mr view <number> --web
glab mr view <number> --output json
```

**View MR diff** (`gitlab:gitlab.read`):

```bash
glab mr diff <number>
glab mr diff <number> --repo <namespace/project>
glab mr diff <number> --color never
```

**View MR approvers** (`gitlab:gitlab.read`):

```bash
glab mr approvers <number>
```

**Create a merge request** (`gitlab:gitlab.write`):

```bash
glab mr create
glab mr create --title "<title>" --description "<body>"
glab mr create --title "<title>" --description "<body>" --target-branch <branch> --source-branch <branch>
glab mr create --title "<title>" --description "<body>" --draft
glab mr create --title "<title>" --description "<body>" --assignee <user>
glab mr create --title "<title>" --description "<body>" --reviewer <user>
glab mr create --title "<title>" --description "<body>" --label "<label>"
glab mr create --title "<title>" --description "<body>" --milestone "<milestone>"
glab mr create --fill
glab mr create --remove-source-branch
glab mr create --squash-before-merge
```

**Merge a merge request** (`gitlab:gitlab.review`):

```bash
glab mr merge <number>
glab mr merge <number> --squash
glab mr merge <number> --delete-source-branch
glab mr merge <number> --auto
```

Only merge when the user explicitly asks. If there are conflicts, warn and do not force-merge.

**Approve a merge request** (`gitlab:gitlab.review`):

```bash
glab mr approve <number>
glab mr approve <number> --sha <commit-sha>
```

**Comment on a merge request** (`gitlab:gitlab.review`):

```bash
glab mr note <number> --message "<comment>"
```

**Close a merge request** (`gitlab:gitlab.write`):

```bash
glab mr close <number>
```

This is destructive. Only run when the user explicitly asks.

**Checkout a merge request** (`gitlab:gitlab.write`):

```bash
glab mr checkout <number>
glab mr checkout <number> --branch <local-branch>
```

### Releases

**List releases** (`gitlab:gitlab.read`):

```bash
glab release list
glab release list --repo <namespace/project>
```

**View a release** (`gitlab:gitlab.read`):

```bash
glab release view <tag>
glab release view <tag> --repo <namespace/project>
glab release view <tag> --web
```

**Download a release asset** (`gitlab:gitlab.read`):

```bash
glab release download <tag>
glab release download <tag> --repo <namespace/project>
glab release download <tag> --asset-name "<name>"
glab release download <tag> --dir <output-dir>
```

**Create a release** (`gitlab:gitlab.write`):

```bash
glab release create <tag>
glab release create <tag> --name "<title>"
glab release create <tag> --notes "<release-notes>"
glab release create <tag> --notes-file <path>
glab release create <tag> --ref <branch-or-commit>
glab release create <tag> --assets-links '[{"name":"asset","url":"https://..."}]'
```

**Upload assets to a release** (`gitlab:gitlab.write`):

```bash
glab release upload <tag> <file1> <file2> ...
```

**Delete a release** (`gitlab:gitlab.write`):

```bash
glab release delete <tag>
glab release delete <tag> --yes
```

This is destructive. Only run when the user explicitly asks.

### Pipelines & CI/CD

**List pipelines** (`gitlab:gitlab.read`):

```bash
glab ci list
glab ci list --repo <namespace/project>
glab ci list --status running
glab ci list --status success
glab ci list --status failed
glab ci list --branch <branch>
glab ci list --per-page 20
glab ci list --output json
```

**View a pipeline** (`gitlab:gitlab.read`):

```bash
glab ci view <pipeline-id>
glab ci view <pipeline-id> --repo <namespace/project>
glab ci view <pipeline-id> --web
```

**View pipeline status** (`gitlab:gitlab.read`):

```bash
glab ci status
glab ci status --branch <branch>
glab ci status --repo <namespace/project>
```

**View pipeline trace/jobs** (`gitlab:gitlab.read`):

```bash
glab ci trace <job-id>
glab ci trace <job-id> --repo <namespace/project>
```

**List CI jobs** (`gitlab:gitlab.read`):

```bash
glab job list
glab job list --repo <namespace/project>
glab job list --pipeline <pipeline-id>
```

**Run a pipeline** (`gitlab:gitlab.write`):

```bash
glab ci run
glab ci run --branch <branch>
glab ci run --repo <namespace/project>
glab ci run --variables "KEY=VALUE"
```

**Retry a pipeline or job** (`gitlab:gitlab.write`):

```bash
glab ci retry <pipeline-id>
glab ci retry <job-id>
```

**Cancel a pipeline** (`gitlab:gitlab.write`):

```bash
glab ci cancel <pipeline-id>
```

### Variables

**List variables** (`gitlab:gitlab.read`):

```bash
glab variable list
glab variable list --repo <namespace/project>
glab variable list --group <group-path>
```

**Set a variable** (`gitlab:gitlab.write`):

```bash
glab variable set <key>
glab variable set <key> --repo <namespace/project>
glab variable set <key> --group <group-path>
glab variable set <key> --value "<value>"
glab variable set <key> --masked
glab variable set <key> --protected
glab variable set <key> --scope "production"
```

Never print variable values in replies. Refer to them by key name only.

**Delete a variable** (`gitlab:gitlab.write`):

```bash
glab variable delete <key>
glab variable delete <key> --repo <namespace/project> --yes
glab variable delete <key> --group <group-path> --yes
```

This is destructive. Only run when the user explicitly asks.

### Snippets

**List snippets** (`gitlab:gitlab.read`):

```bash
glab snippet list
glab snippet list --public
glab snippet list --private
glab snippet list --per-page 50
```

**View a snippet** (`gitlab:gitlab.read`):

```bash
glab snippet view <snippet-id>
glab snippet view <snippet-id> --web
```

**Create a snippet** (`gitlab:gitlab.write`):

```bash
glab snippet create
glab snippet create --title "<title>" --filename <file>
glab snippet create --title "<title>" --filename <file> --description "<desc>"
glab snippet create --title "<title>" --filename <file> --public
glab snippet create --title "<title>" --filename <file> --private
```

**Delete a snippet** (`gitlab:gitlab.write`):

```bash
glab snippet delete <snippet-id>
```

This is destructive. Only run when the user explicitly asks.

### API Access

**Read** (`gitlab:gitlab.read`):

```bash
glab api projects/<namespace>%2F<project>
glab api projects/<namespace>%2F<project>/issues --jq '.[].title'
glab api search --field scope=projects --field search="<query>"
```

**Write** (`gitlab:gitlab.write`):

```bash
glab api projects/<namespace>%2F<project>/repository/branches -X POST -F branch=<name> -F ref=<ref>
```

Note: In GitLab API paths, the project namespace uses `%2F` as the separator (e.g., `group%2Fproject`).

### Local Operations & Project Workspace

The designated workspace for cloned repositories is the `Project workspace` directory shown in the session contract (typically `/home/agent/workspace/projects`). When you need to clone and work on a repo locally, use this path:

```
workspace/projects/<namespace>/<project>/
```

**Clone a repository to the workspace** (`gitlab:gitlab.write`):

```bash
mkdir -p projects/<namespace>
cd projects/<namespace>
glab repo clone <namespace/project>
cd <project>
```

**Pattern: clone, work, push**:

```bash
# 1. Clone into the project workspace
mkdir -p projects/<namespace>
cd projects/<namespace>
glab repo clone <namespace/project>
cd <project>

# 2. Work: create branch, edit files, commit
git checkout -b feature/my-change
# edit files...
git add .
git commit -m "feat: description"

# 3. Push and create MR
git push -u origin feature/my-change
glab mr create --title "Title" --description "Description" --target-branch main --source-branch feature/my-change
```

**Checkout an MR for review**:

```bash
cd projects/<namespace>/<project>
glab mr checkout <number>
```

Never clone into the thread session directory or a temporary directory. Always use `workspace/projects/<namespace>/<project>/`.

## Command Reference

### Global Flags
Apply these to any `glab` command:

| Flag | Usage |
|---|---|
| `--repo <namespace/project>` | Target repository (default: auto-detected from git remote) |
| `--page <n>` | Page number for paginated results |
| `--per-page <n>` | Items per page (max 100) |
| `--output json` | JSON output format |
| `-R, --repo <namespace/project>` | Shorthand for --repo |
| `--yes` | Skip confirmation prompts |
| `--hostname <host>` | Target GitLab instance hostname |

## Quick Examples
Every example includes the required env setup. Copy the full sequence.

### List your GitLab repositories
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab repo list --all
```

### View a specific repository
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab repo view my-group/my-project --output json
```

### Create a private repository
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab repo create --name my-new-project --private --description "A new project"
```

### List issues with labels
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab issue list --repo my-group/my-project --label bug --state opened --per-page 20
```

### Create an issue
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab issue create --repo my-group/my-project --title "Fix login bug" --description "Users cannot log in with SSO" --label bug
```

### Create and merge a merge request
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab mr create --repo my-group/my-project --title "Add feature X" --description "Implements feature X" --target-branch main --source-branch feature-branch
glab mr merge <number> --squash --delete-source-branch
```

### Create a release
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab release create v1.0.0 --repo my-group/my-project --name "v1.0.0 Initial Release" --notes "First stable release"
```

### View and retry a failed pipeline
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab ci list --repo my-group/my-project --status failed --per-page 5
glab ci retry <pipeline-id>
```

### Set a CI/CD variable
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab variable set DEPLOY_KEY --repo my-group/my-project --value "<secret-value>" --masked
```

### List and view a snippet
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab snippet list
glab snippet view <snippet-id>
```

### Trigger a pipeline
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
glab ci run --repo my-group/my-project --branch main --variables "DEPLOY=true"
```

### Clone and work on a project
```bash
export GITLAB_TOKEN="$GITLAB_TOKEN"
glab auth status
mkdir -p projects/my-group
cd projects/my-group
glab repo clone my-group/my-project
cd my-project
git checkout -b fix-typo
```

## Output
- Keep replies concise and operational.
- Include project path, issue/MR number, release tag, pipeline ID, and relevant identifiers.
- When listing, use a compact format: one line per item.
- Report errors with the exact `glab` command attempted and the error message.
- Separate confirmed GitLab facts from assumptions.
- If blocked by missing token, missing CLI, or API errors, state the blocker and the smallest next step.
- Never print the `GITLAB_TOKEN` value, variable values, or full token material.

## Checks
- Always export `GITLAB_TOKEN` before any GitLab command.
- Always verify the token with `glab auth status` before doing real work.
- Never print credential values, tokens, or variable values.
- If the `glab` CLI binary is missing, tell the user to use `install-tool` first.
- If an operation is ambiguous, treat it as write.
- Destructive operations must be explicitly requested by the user before proceeding.
- Use `--repo namespace/project` explicitly when the current working directory is not a git clone of the target.
- For API calls, project paths use `%2F` as the namespace separator (e.g., `group%2Fproject`).
- Tokens are in the environment

## Cross-skill convention
Other skills that need GitLab operations (creating issues, triggering pipelines, reading project data) should not embed their own `glab` commands. Route GitLab work through this skill.
