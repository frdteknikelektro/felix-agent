---
status: accepted
---

# Use a closed canonical workspace placement contract

Felix treats `WORKSPACE_FOLDER_STRUCTURE.md` as an exhaustive placement contract: Hosted Projects live at `projects/<provider>/<namespace>/<repo>/`, Local Projects at `projects/local/<project>/`, persistent non-software File Collections at `files/<collection>/`, request-specific intermediate work in the current Session's `work/`, and conversational inputs and finished deliverables in its `attachments/`. This keeps durable software, durable user files, and session-scoped artifacts distinct; ordinary Local Project and file operations are open to all contacts under safety guardrails, while Hosted Project acquisition and mutation retain `software-development:repo.write`.

Local Projects are promoted automatically when an unambiguous GitHub or GitLab remote supplies a canonical Hosted Project path and the destination is absent; promotion is a Hosted Project mutation and therefore requires `software-development:repo.write`, but no additional user confirmation. Collisions stop for user direction, Hosted Projects are not automatically demoted when a remote disappears, and existing legacy folders are not migrated automatically.

Human-created artifact and non-project descendant paths must use safe readable slugs (with lowercase file extensions), while Project descendants may retain ecosystem-required names. Every target must remain within the real path of its selected canonical category under `$WORKSPACE_DIR`, Session targets must match the active thread, existing hard-linked files are rejected conservatively, and no operation may introduce an undocumented workspace-root category. Felix installs `felix-workspace-path` at boot; agent instructions and bundled filesystem-mutating Skills require it before every user-work mutation so the placement rule has an operational enforcement seam rather than relying on prose alone.
