---
status: accepted
---

# Use a closed canonical workspace placement contract

Felix treats `WORKSPACE_FOLDER_STRUCTURE.md` as an exhaustive placement contract: Hosted Projects live at `projects/<provider>/<namespace>/<repo>/`, Local Projects at `projects/local/<project>/`, persistent non-software File Collections at `files/<collection>/`, request-specific intermediate work in the current Session's `work/`, and conversational inputs and finished deliverables in its `attachments/`. This keeps durable software, durable user files, and session-scoped artifacts distinct; ordinary Local Project and file operations are open to all contacts under safety guardrails, while Hosted Project acquisition and mutation retain `software-development:repo.write`.

Local Projects are promoted automatically when an unambiguous GitHub or GitLab remote supplies a canonical Hosted Project path and the destination is absent; collisions stop for user direction, Hosted Projects are not automatically demoted when a remote disappears, and existing legacy folders are not migrated automatically. Agent-created paths must use safe readable slugs, remain within the real path of `$WORKSPACE_DIR`, and never introduce undocumented workspace-root categories.
