---
name: software-development
description: Matt-style local software development workflow. Use for project setup, PRDs, issue slices, implementation, debugging, TDD, reviews, refactors, or handoffs.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: repo.write
  match: software development, code, implement, feature, bug fix, debug, refactor, test, build, review code
---

# Software Development

Adapt Matt Pocock's promoted engineering/productivity workflow for Felix. Treat upstream copies as reference material; route work through this compact local process.

## Permissions

- `repo.write` — Hosted Project acquisition and mutations: cloning, editing code, changing dependencies, resolving conflicts, staging, or committing.

Read-only work is open. Local Project creation and mutation require no permission. Emit `PERMISSION_REQUIRED` for `software-development:repo.write` before acquiring or mutating a Hosted Project. Stage, commit, pull, rebase, force, or destructive operations only when explicitly requested and safe for the worktree.

## Execution

1. Classify and resolve the Project.
   Completion: a no-remote Project has a readable safe path at `$WORKSPACE_DIR/projects/local/<project>`; a Hosted Project resolves from an explicit path, HTTPS/SSH Git URL, exact `<provider>/<namespace>/<repo>` triple, active-session context, or the only candidate. Otherwise ask.
2. Acquire or create the Project when missing.
   Completion: a Local Project is created at `projects/local/<project>/` with no permission, or a Hosted Project is cloned to `projects/<provider>/<namespace>/<repo>/` after `software-development:repo.write` is granted. Do not broad-search vague names.
3. Inspect before changing.
   Completion: Project kind, current branch, remotes, dirty state, relevant docs, manifests, files, and likely checks are known. Existing clones are not automatically pulled; fetch/pull/rebase only when requested or needed and safe.
4. Route the request through the matching branch.
   Completion: the branch below accounts for every requested output, mutation, or non-action.
5. Reclassify after remote changes.
   Completion: when a Local Project has a recognized GitHub or GitLab remote and its canonical Hosted destination is absent, automatically promote the complete Project without merging or overwriting, then verify the remote, Git state, and new path. On ambiguity or collision, stop and ask. Never automatically demote a Hosted Project.
6. Verify and report.
   Completion: targeted checks were run, or the exact blocker is stated; report changed files, behavior, commands, failures, residual risks, and paths relative to `$WORKSPACE_DIR`.

## Branches

| Request | Route |
|---|---|
| Unsure where to start | Use the ask-matt flow: grill/design first, then PRD/issues for multi-session work, otherwise implement directly. |
| New idea or unclear feature | Grill with docs: ask one question at a time, sharpen terms, update `CONTEXT.md` only for resolved glossary terms, and offer ADRs sparingly. |
| PRD | Write `docs/prds/<slug>.md` in the project using problem, solution, user stories, implementation decisions, testing decisions, out of scope, and notes. |
| Issue breakdown | Write independently buildable vertical slices to `docs/issues/<slug>.md`; each issue has what to build, acceptance criteria, and blockers. |
| Implementation | Use TDD where possible: failing test, smallest fix, refactor, regular typecheck/single-test runs, full suite at the end when practical. |
| Bug | Use diagnosis loop: reproduce, minimize, hypothesize, instrument, fix, and add a regression test. Do not patch before a feedback loop exists when feasible. |
| Review | Use code-review stance: findings first, ordered by severity, grounded in file/line references; separate standards concerns from spec mismatches. |
| Refactor/design | Use codebase-design vocabulary: improve seams, deepen modules, preserve behavior, and test through the highest stable interface. |
| Prototype | Build throwaway code only to answer a design question, then preserve the learning in docs or the reply and remove or isolate the throwaway artifact. |
| Handoff | Write `docs/handoffs/<slug>.md` with current state, decisions, open questions, files touched, verification, and next action. |

## Branch reference

Promoted Matt Pocock skills are installed under `.agents/skills/`. Treat them as reference material, not Felix skills. Read the relevant upstream `SKILL.md` only when this compact orchestrator lacks enough detail for a branch.

Add `references/<branch>.md` only for Felix-specific deltas that do not belong in upstream reference material, then read that file before following the local delta.

## Constraints

- Prefer `rg` or `rg --files` for search. Use existing frameworks, helpers, test style, and error handling.
- Read nearby code before adding abstractions.
- Add tests when behavior changes, a bug is fixed, or a contract is touched.
- Follow `WORKSPACE_FOLDER_STRUCTURE.md` as an exhaustive placement contract; Skills cannot override it, and unknown legacy folders are not migrated automatically.
- Create `docs/prds/`, `docs/issues/`, and `docs/handoffs/` lazily inside the selected project; do not create `docs/software-development/`.
- Report project paths relative to `$WORKSPACE_DIR`, such as `projects/github/acme/shop/docs/prds/change.md`.
- Keep generated artifacts, dependency updates, formatting churn, and lockfile changes out of scope unless required by the task.
- Never expose secret values in logs or responses.
- Do not run destructive git commands, delete user data, force push, rotate secrets, or modify production systems unless explicitly requested and permission is granted.
- Keep one source of truth for each rule.
- Give fragile operations exact commands or a bundled script; leave variable work at higher freedom.
- List bare permissions as `{domain}.{action}`. Felix namespaces them as `{skill-id}:{permission}`.
- Keep output contracts only when another machine parses them.
- End each step with a checkable, exhaustive completion criterion.
