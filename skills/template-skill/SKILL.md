---
name: template-skill
description: Replace with one leading-word description of the capability and one trigger for each distinct branch.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  permissions: template.read, template.write
  match: replace with trigger phrase
# env:
#   - key: SERVICE_API_KEY
#     description: Access token for the service
#     required: true
---

# Template Skill

Replace this file; do not add sections merely because they appear here.

## Permissions

List every permission in frontmatter `permissions:` and explain what each gates below. When a skill needs no permissions, omit the frontmatter key and write:

```
No permissions required. <one-liner why>.
```

Otherwise, list each permission with a concrete boundary:

- `template.read` — Read-only operations: listing, inspecting, querying state.
- `template.write` — Mutations: creating, updating, deleting, or transitioning state.

When a branch needs only read access, require only `template.read`. When any mutation is possible, require `template.write`. Emit `PERMISSION_REQUIRED` for the narrowest set the current operation actually needs.

## Execution

1. Perform the first ordered action.
   Completion: state the observable condition that proves this step finished.
2. Perform the next action.
   Completion: account for every required output, mutation, or failure.
3. Verify the result independently and report it.

## Branch reference

Keep instructions needed by every run above. Put branch-specific schemas, commands, and examples in `references/<branch>.md`, then add a pointer that states exactly when to read it.

## Constraints

- Keep one source of truth for each rule.
- Give fragile operations exact commands or a bundled script; leave variable work at higher freedom.
- List bare permissions as `{domain}.{action}`. Felix namespaces them as `{skill-id}:{permission}`.
- Keep output contracts only when another machine parses them.
- End each step with a checkable, exhaustive completion criterion.
