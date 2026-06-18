---
id: github
name: GitHub Management
description: Full GitHub management via the gh CLI — repos, issues, PRs, releases, workflows, secrets, variables, gists, search, and auth. Uses GITHUB_TOKEN (available in environment). Uses text-based read/write permission guidance.
version: 1
enabled: true
kind: operational
permissions:
  - github.read
  - github.review
  - github.write
match:
  - github
  - repo
  - repository
  - issue
  - issues
  - pr
  - pull request
  - release
  - workflow
  - actions
  - gist
  - secret
  - variable
  - code search
  - codespace
  - git clone
  - git branch
  - git commit
  - git push
  - git checkout
---

# GitHub Management

## Purpose
Operate GitHub through the `gh` CLI. This skill covers repository management, issues, pull requests, releases, Actions workflows, secrets and variables, gists, search, and API access.

Use text-based permission judgment. Do not add or rely on hardcoded TypeScript command detection for GitHub read/write classification.

## Permission Policy
Use the requested intent and the likely GitHub effect to choose the required permission:

- `github:github.read` — inspection, listing, viewing, searching, downloading, and commands whose purpose is to observe existing state. Examples: `repo list`, `repo view`, `issue list`, `issue view`, `issue search`, `pr list`, `pr view`, `pr diff`, `release list`, `release view`, `release download`, `run list`, `run view`, `run watch`, `workflow list`, `secret list`, `variable list`, `gist list`, `gist view`, `search`, `auth status`, `api GET`.
- `github:github.review` — adding comments, approving pull requests, merging pull requests, and other collaborative review actions that do not create, edit, or delete GitHub resources. Examples: `pr review --approve`, `pr review --comment`, `pr review --request-changes`, `pr merge`, `pr merge --squash`, `pr merge --rebase`.
- `github:github.write` — create, edit, close, reopen, fork, archive, rename, delete, rerun, cancel, set, and any other operation that can change remote GitHub state.

If an operation is ambiguous, treat it as `github:github.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks for the specific destructive intent: `repo delete`, `release delete`, `secret delete`, `variable delete`, `gist delete`, `pr close` without merge, merging conflicting PRs.

## Environment
Use tokens from the environment before every `gh` CLI command. Do not use credential files.

Required variable:
- `GITHUB_TOKEN` — GitHub personal access token (classic or fine-grained)

Command pattern:

```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
```

Verify the token is valid before any GitHub work:

```bash
test -n "$GITHUB_TOKEN" &&
export GITHUB_TOKEN="$GITHUB_TOKEN" &&
gh auth status
```

If `gh auth status` fails, check that `GITHUB_TOKEN` is set and valid. Never print the token value.

For self-managed GitHub Enterprise Server instances, export the host:

```bash
export GH_HOST="github.example.com"
```

## CLI Not Found
If a `gh` command fails because the binary is missing (exit code 127, "command not found"), report it as a runtime error — not as a pre-check. Say: "The `gh` CLI is not installed. Use `install-tool` to install it, then retry."

Do not pre-emptively check for the CLI. Do not gate the workflow on CLI presence. Let gh commands fail naturally and handle the failure. The only gate in this skill is the permission gate.

## Workflow
0. **Resolve permissions FIRST.** Before doing anything else — before checking CLI availability, before running any command — determine whether the user has permission for the requested work. If permission is missing, emit PERMISSION_REQUIRED. Never skip this step. Never run operational checks (CLI, token, env) before the permission gate.
1. Classify the requested work as read or write using the permission policy above.
2. export `GITHUB_TOKEN`, and verify with `gh auth status` without exposing the token value. Determine the target repo with `gh repo view` or `gh repo list` if needed.
3. Run direct `gh` CLI commands. If the `gh` binary is not found (exit code 127, "command not found"), tell the user to install it with `install-tool` and stop — do not retry.
4. For read tasks, return confirmed GitHub facts and include the relevant command summary.
5. For write tasks, perform only the requested change. For destructive work, proceed only when the user's request explicitly names the destructive intent.
6. Report command outcomes concisely, including the repo name, issue/PR number, release tag, workflow name, secret/variable key (values redacted), and any GitHub errors.

## Operations

### Auth & Identity
Read-only (`github:github.read`):

```bash
gh auth status
gh auth status --hostname <github-enterprise-host>
```

Returns authentication state. Use this to confirm the token works.

**Pull Current User** (`github:github.read`):

```bash
gh api user
gh api user --jq '.login'
```

### Repositories

**List repositories** (`github:github.read`):

```bash
gh repo list [owner]
gh repo list [owner] --limit 100
gh repo list [owner] --language <lang>
gh repo list [owner] --source
gh repo list [owner] --fork
gh repo list [owner] --archived
gh repo list [owner] --no-archived
```

**View a repository** (`github:github.read`):

```bash
gh repo view [owner/repo]
gh repo view [owner/repo] --json name,description,url,stargazerCount,forkCount,defaultBranchRef
gh repo view [owner/repo] --web
```

**Create a repository** (`github:github.write`):

```bash
gh repo create <name>
gh repo create <name> --description "<desc>"
gh repo create <name> --public
gh repo create <name> --private
gh repo create <name> --clone
gh repo create <name> --template <template-repo>
```

**Edit a repository** (`github:github.write`):

```bash
gh repo edit [owner/repo]
gh repo edit [owner/repo] --description "<desc>"
gh repo edit [owner/repo] --add-topic <topic>
gh repo edit [owner/repo] --remove-topic <topic>
gh repo edit [owner/repo] --enable-wiki=false
gh repo edit [owner/repo] --default-branch <branch>
```

**Fork a repository** (`github:github.write`):

```bash
gh repo fork [owner/repo]
gh repo fork [owner/repo] --clone
gh repo fork [owner/repo] --remote
```

**Archive a repository** (`github:github.write`):

```bash
gh repo archive [owner/repo] --yes
```

**Rename a repository** (`github:github.write`):

```bash
gh repo rename <new-name>
gh repo rename <new-name> --repo [owner/repo] --yes
```

**Delete a repository** (`github:github.write`):

```bash
gh repo delete [owner/repo] --yes
```

This is destructive. Only run when the user explicitly asks.

### Local Operations & Project Workspace

The designated workspace for cloned repositories is the `Project workspace` directory shown in the session contract (typically `/home/agent/workspace/projects`). When you need to clone and work on a repo locally, use this path:

```
workspace/projects/<owner>/<repo>/
```

**Clone a repository to the workspace** (`github:github.write`):

```bash
mkdir -p projects/<owner>
cd projects/<owner>
gh repo clone <owner/repo>
cd <repo>
```

**Pattern: clone, work, push**:

```bash
# 1. Clone into the project workspace
mkdir -p projects/<owner>
cd projects/<owner>
gh repo clone <owner/repo>
cd <repo>

# 2. Work: create branch, edit files, commit
git checkout -b feature/my-change
# edit files...
git add .
git commit -m "feat: description"

# 3. Push and create PR
git push -u origin feature/my-change
gh pr create --title "Title" --body "Description" --base main --head feature/my-change
```

**Checkout a PR for review**:

```bash
cd projects/<owner>/<repo>
gh pr checkout <number>
```

**Fork and clone**: Same as clone, substituting `gh repo fork --clone`:

```bash
gh repo fork <owner/repo> --clone
cd <repo>
```

Once inside a cloned repo, `gh` commands auto-detect the repository from the git remote. You do not need `--repo` in that case. Always `cd` into the project workspace directory before running git or repo-local gh commands.

Never clone into the thread session directory or a temporary directory. Always use `workspace/projects/<owner>/<repo>/`.

### Issues

**List issues** (`github:github.read`):

```bash
gh issue list
gh issue list --repo [owner/repo]
gh issue list --label "<label>"
gh issue list --assignee <user>
gh issue list --state open
gh issue list --state closed
gh issue list --limit 50
gh issue list --search "<query>" --json number,title,state,labels
gh issue list --json number,title,state,assignees,labels,createdAt,updatedAt
```

**View an issue** (`github:github.read`):

```bash
gh issue view <number>
gh issue view <number> --repo [owner/repo]
gh issue view <number> --comments
gh issue view <number> --json number,title,body,state,labels,assignees,comments
gh issue view <number> --web
```

**Search issues** (`github:github.read`):

```bash
gh search issues <query>
gh search issues <query> --limit 50
gh search issues <query> --repo [owner/repo]
gh search issues <query> --json number,title,state,repository
```

**Create an issue** (`github:github.write`):

```bash
gh issue create
gh issue create --title "<title>" --body "<body>"
gh issue create --title "<title>" --body "<body>" --repo [owner/repo]
gh issue create --title "<title>" --body "<body>" --assignee <user>
gh issue create --title "<title>" --body "<body>" --label "<label>"
gh issue create --title "<title>" --body-file <file-path>
```

**Close/Reopen an issue** (`github:github.write`):

```bash
gh issue close <number>
gh issue close <number> --comment "<reason>"
gh issue reopen <number>
gh issue reopen <number> --comment "<reason>"
```

**Edit an issue** (`github:github.write`):

```bash
gh issue edit <number>
gh issue edit <number> --title "<new-title>"
gh issue edit <number> --body "<new-body>"
gh issue edit <number> --add-label "<label>"
gh issue edit <number> --remove-label "<label>"
```

### Pull Requests

**List pull requests** (`github:github.read`):

```bash
gh pr list
gh pr list --repo [owner/repo]
gh pr list --state open
gh pr list --state closed
gh pr list --state merged
gh pr list --base <branch>
gh pr list --label "<label>"
gh pr list --assignee <user>
gh pr list --author <user>
gh pr list --limit 50
gh pr list --search "<query>" --json number,title,state,author,createdAt
```

**View a pull request** (`github:github.read`):

```bash
gh pr view <number>
gh pr view <number> --repo [owner/repo]
gh pr view <number> --comments
gh pr view <number> --json number,title,body,state,reviews,commits,files
gh pr view <number> --web
```

**View PR diff** (`github:github.read`):

```bash
gh pr diff <number>
gh pr diff <number> --repo [owner/repo]
gh pr diff <number> --color never
```

**View PR review/comments** (`github:github.read`):

```bash
gh pr review <number> --json body,author,state,submittedAt
gh api repos/[owner]/[repo]/pulls/<number>/comments
```

**Create a pull request** (`github:github.write`):

```bash
gh pr create
gh pr create --title "<title>" --body "<body>"
gh pr create --title "<title>" --body "<body>" --base <branch> --head <branch>
gh pr create --title "<title>" --body "<body>" --draft
gh pr create --title "<title>" --body "<body>" --label "<label>"
gh pr create --title "<title>" --body "<body>" --assignee <user>
gh pr create --fill
```

**Merge a pull request** (`github:github.review`):

```bash
gh pr merge <number>
gh pr merge <number> --merge
gh pr merge <number> --squash
gh pr merge <number> --rebase
gh pr merge <number> --auto
gh pr merge <number> --delete-branch
```

Only merge when the user explicitly asks. If there are conflicts, warn and do not force-merge.

**Review a pull request** (`github:github.review`):

```bash
gh pr review <number> --approve
gh pr review <number> --comment --body "<feedback>"
gh pr review <number> --request-changes --body "<reason>"
```

**Close a pull request** (`github:github.write`):

```bash
gh pr close <number>
gh pr close <number> --comment "<reason>"
```

This is destructive. Only run when the user explicitly asks.

**Checkout a pull request** (`github:github.write`):

```bash
gh pr checkout <number>
gh pr checkout <number> --recurse-submodules
```

### Releases

**List releases** (`github:github.read`):

```bash
gh release list
gh release list --repo [owner/repo]
gh release list --limit 20
gh release list --exclude-drafts
gh release list --exclude-pre-releases
```

**View a release** (`github:github.read`):

```bash
gh release view <tag>
gh release view <tag> --repo [owner/repo]
gh release view <tag> --json name,tagName,body,publishedAt,assets
gh release view <tag> --web
```

**Download a release asset** (`github:github.read`):

```bash
gh release download <tag>
gh release download <tag> --repo [owner/repo]
gh release download <tag> --pattern "<glob>"
gh release download <tag> --dir <output-dir>
gh release download <tag> --archive zip
```

**Create a release** (`github:github.write`):

```bash
gh release create <tag>
gh release create <tag> --title "<title>"
gh release create <tag> --notes "<release-notes>"
gh release create <tag> --notes-file <path>
gh release create <tag> --target <branch>
gh release create <tag> --draft
gh release create <tag> --prerelease
gh release create <tag> <file1> <file2> ...
```

**Upload assets to a release** (`github:github.write`):

```bash
gh release upload <tag> <file1> <file2> ...
gh release upload <tag> <file> --repo [owner/repo]
```

**Delete a release** (`github:github.write`):

```bash
gh release delete <tag>
gh release delete <tag> --yes
```

This is destructive. Only run when the user explicitly asks.

### Actions & Workflows

**List workflow runs** (`github:github.read`):

```bash
gh run list
gh run list --repo [owner/repo]
gh run list --workflow <workflow-name>
gh run list --branch <branch>
gh run list --limit 20
gh run list --status success
gh run list --status failure
gh run list --json name,status,conclusion,headBranch,createdAt,workflowDatabaseId
```

**View a run** (`github:github.read`):

```bash
gh run view <run-id>
gh run view <run-id> --repo [owner/repo]
gh run view <run-id> --log
gh run view <run-id> --job <job-id>
gh run view <run-id> --web
```

**Watch a run** (`github:github.read`):

```bash
gh run watch <run-id>
gh run watch <run-id> --exit-status
gh run watch <run-id> --interval 10
```

**List workflows** (`github:github.read`):

```bash
gh workflow list
gh workflow list --repo [owner/repo]
gh workflow list --limit 20
```

**Rerun a workflow** (`github:github.write`):

```bash
gh run rerun <run-id>
gh run rerun <run-id> --failed
```

**Cancel a workflow run** (`github:github.write`):

```bash
gh run cancel <run-id>
```

**Trigger a workflow** (`github:github.write`):

```bash
gh workflow run <workflow-name>
gh workflow run <workflow-name> --repo [owner/repo]
gh workflow run <workflow-name> --ref <branch>
gh workflow run <workflow-name> -f key=value
```

### Secrets & Variables

**List secrets** (`github:github.read`):

```bash
gh secret list
gh secret list --repo [owner/repo]
gh secret list --org <org-name>
```

**List variables** (`github:github.read`):

```bash
gh variable list
gh variable list --repo [owner/repo]
gh variable list --org <org-name>
```

**Set a secret** (`github:github.write`):

```bash
gh secret set <key>
gh secret set <key> --repo [owner/repo]
gh secret set <key> --org <org-name>
gh secret set <key> --body "<value>"
gh secret set <key> < <file-containing-value>
```

Never print secret values in replies. Refer to them by key name only.

**Delete a secret** (`github:github.write`):

```bash
gh secret delete <key>
gh secret delete <key> --repo [owner/repo] --yes
gh secret delete <key> --org <org-name> --yes
```

This is destructive. Only run when the user explicitly asks.

**Set a variable** (`github:github.write`):

```bash
gh variable set <key>
gh variable set <key> --repo [owner/repo]
gh variable set <key> --org <org-name>
gh variable set <key> --body "<value>"
```

**Delete a variable** (`github:github.write`):

```bash
gh variable delete <key>
gh variable delete <key> --repo [owner/repo] --yes
gh variable delete <key> --org <org-name> --yes
```

This is destructive. Only run when the user explicitly asks.

### Gists

**List gists** (`github:github.read`):

```bash
gh gist list
gh gist list --limit 50
gh gist list --public
gh gist list --secret
```

**View a gist** (`github:github.read`):

```bash
gh gist view <gist-id>
gh gist view <gist-id> --raw
gh gist view <gist-id> --files
gh gist view <gist-id> --web
```

**Create a gist** (`github:github.write`):

```bash
gh gist create <file>
gh gist create <file1> <file2> ...
gh gist create <file> --desc "<description>"
gh gist create <file> --public
gh gist create - <<< "$content"
```

**Edit a gist** (`github:github.write`):

```bash
gh gist edit <gist-id>
gh gist edit <gist-id> --desc "<new-description>"
gh gist edit <gist-id> --add <file>
```

**Delete a gist** (`github:github.write`):

```bash
gh gist delete <gist-id>
```

This is destructive. Only run when the user explicitly asks.

### Search

**Search repositories** (`github:github.read`):

```bash
gh search repos <query>
gh search repos <query> --limit 50
gh search repos "language:typescript stars:>100"
gh search repos <query> --json name,url,stargazersCount
```

**Search issues** (`github:github.read`):

```bash
gh search issues <query>
gh search issues <query> --limit 50
gh search issues "label:bug state:open"
gh search issues <query> --json number,title,state,repository
```

**Search pull requests** (`github:github.read`):

```bash
gh search prs <query>
gh search prs <query> --limit 50
gh search prs "is:open draft:true"
gh search prs <query> --json number,title,state,author
```

**Search commits** (`github:github.read`):

```bash
gh search commits <query>
gh search commits <query> --limit 50
gh search commits "fix: repo:<owner/repo>"
```

**Search code** (`github:github.read`):

```bash
gh search code <query>
gh search code <query> --limit 100
gh search code "class User repo:<owner/repo>"
gh search code <query> --language <lang>
gh search code <query> --extension <ext>
gh search code <query> --json path,repository
```

### API Access

**Read** (`github:github.read`):

```bash
gh api repos/[owner]/[repo]
gh api repos/[owner]/[repo]/issues --jq '.[].title'
gh api -H "Accept: application/vnd.github+json" /repos/[owner]/[repo]
```

**Write** (`github:github.write`):

```bash
gh api repos/[owner]/[repo]/git/refs -X POST -f ref="refs/heads/new-branch" -f sha="<commit-sha>"
```

## Command Reference

### Global Flags
Apply these to any `gh` command:

| Flag | Usage |
|---|---|
| `--repo [owner/repo]` | Target repository (default: auto-detected from git remote) |
| `-R, --repo [owner/repo]` | Shorthand for --repo |
| `--limit <n>` | Maximum results per page |
| `--json <fields>` | JSON output with specified fields |
| `-q, --jq <expression>` | Filter JSON output with jq expression |
| `--web` | Open in browser |

### The `--repo` Flag
Most `gh` commands auto-detect the repository from the git remote of the current working directory. For cross-repo operations or when not inside a git repo, explicitly pass `--repo owner/repo`:

```bash
gh issue list --repo octocat/hello-world
gh pr list --repo octocat/hello-world
gh secret set MY_SECRET --repo octocat/hello-world
```

## Quick Examples
Every example includes the required env setup. Copy the full sequence.

### List repositories for an owner
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh repo list my-org --limit 50
```

### View a specific repository
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh repo view owner/repo --json name,description,url,stargazerCount,defaultBranchRef
```

### Create a private repository
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh repo create my-new-repo --private --description "A new project"
```

### List issues with labels
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh issue list --repo owner/repo --label bug --state open --limit 20
```

### Create an issue
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh issue create --repo owner/repo --title "Fix login bug" --body "Users cannot log in with SSO" --label bug
```

### Create and merge a pull request
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh pr create --repo owner/repo --title "Add feature X" --body "Implements feature X" --base main --head feature-branch
gh pr merge <number> --squash --delete-branch
```

### Create a release with notes
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh release create v1.0.0 --repo owner/repo --title "v1.0.0 Initial Release" --notes "First stable release" --generate-notes
```

### View and rerun a failed workflow
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh run list --repo owner/repo --status failure --limit 5
gh run rerun <run-id> --failed
```

### Set a repository secret
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh secret set DEPLOY_KEY --repo owner/repo --body "<secret-value>"
```

### Search code across repositories
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh search code "TODO repo:owner/repo" --limit 20 --json path,repository
```

### Create and view a gist
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh gist create my-script.sh --desc "Useful helper script"
gh gist list --limit 5
```

### Trigger a workflow dispatch
```bash
export GITHUB_TOKEN="$GITHUB_TOKEN"
gh auth status
gh workflow list --repo owner/repo
gh workflow run deploy.yml --repo owner/repo --ref main -f environment=production
```

## Output
- Keep replies concise and operational.
- Include repo name, issue/PR number, release tag, workflow name, and relevant identifiers.
- When listing, use a compact format: one line per item.
- Report errors with the exact `gh` command attempted and the error message.
- Separate confirmed GitHub facts from assumptions.
- If blocked by missing token, missing CLI, or API errors, state the blocker and the smallest next step.
- Never print the `GITHUB_TOKEN` value, secret values, or full signed request material.

## Checks
- Always export `GITHUB_TOKEN` before any GitHub command.
- Always verify the token with `gh auth status` before doing real work.
- Never print credential values, tokens, or secret values.
- If the `gh` CLI binary is missing, tell the user to use `install-tool` first.
- If an operation is ambiguous, treat it as write.
- Destructive operations must be explicitly requested by the user before proceeding.
- Use `--repo owner/repo` explicitly when the current working directory is not a git clone of the target.
- Tokens are in the environment

## Cross-skill convention
Other skills that need GitHub operations (creating issues, triggering workflows, reading repo data) should not embed their own `gh` commands. Route GitHub work through this skill.
