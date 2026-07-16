---
name: template-skill
description: Reference scaffold for a Felix skill definition. Use when the user asks to inspect or understand the bundled skill template.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  match: skill template, skill definition scaffold, example SKILL.md
---

# Skill Definition Template

No permissions required. This skill explains the scaffold only; creating or
editing an installed skill belongs to the `skill-creator` skill and its
`skill.write` permission boundary.

## Execution

1. Explain the relevant part of the scaffold below, or reproduce it when the
   user explicitly asks for a template.
2. Point out that `metadata.permissions` is omitted for reply-only behavior and
   contains the narrowest permission names when a skill can mutate state.
3. For an actual create or edit request, defer to `skill-creator`.

## Scaffold

```markdown
---
name: example-skill
description: One leading capability phrase plus the triggers that should select it.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  permissions: example.read, example.write
  match: example trigger, second trigger
# env:
#   - key: SERVICE_API_KEY
#     description: Access token for the service.
#     required: true
#     secret: true
---

# Example Skill

## Permissions

- `example.read` — Inspect the service without changing it.
- `example.write` — Create, update, or delete service state.

## Execution

1. Perform the first ordered action.
   Completion: state the observable condition proving the step finished.
2. Perform the next action.
   Completion: account for every required output, mutation, or failure.
3. Verify the result independently and report it.
```

Use branch-specific files under `references/` only when they reduce the common
instruction path. Helper scripts belong under `scripts/` and must preserve the
same permission boundary as the prose.
