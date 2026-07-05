---
id: skill-creator
name: Skill Creator
description: Permission-based wizard for creating or editing Felix catalog skills from chat, docs, URLs, attachments, or repo context.
version: 1
enabled: true
kind: operational
permissions:
  - skill.write
match:
  - skill creator
  - create skill
  - edit skill
  - skill wizard
  - manage skills
---

# Skill Creator

Create or edit Felix skills in `${WORKSPACE_DIR}/catalog/skills` through a chat wizard. Reading/listing existing skill definitions is open; creating or editing skills requires `skill.write` through the normal owner approval flow.

## Permissions

- `skill.write` — Create or update skill folders, `SKILL.md`, reference files, helper files, and `index.md`.

Listing or inspecting existing catalog skills is read-only and does not require a skill permission.

## Permission gate

Use the standard Felix permission flow for writes. If the requester does not already have `skill.write` and wants to create or edit a skill, emit `PERMISSION_REQUIRED`; the owner decides whether to approve once or permanently. Do not add a separate owner-identity check.

## Branches

| Request | Route |
|---|---|
| List or inspect skills | Read the relevant catalog skill files directly; no permission required. |
| Create a new skill | Grill until the spec is clear, then require `skill.write` and write the skill files directly. |
| Edit an existing skill | Inspect it, grill the intended delta, then require `skill.write` and edit the skill files directly. |

## Grilling flow

Use Matt-style grilling: ask one specific question at a time and wait. Asking many questions at once is bewildering.

If an answer can be derived from existing skill files, URLs/docs, attachments, or repo files, inspect those instead of asking. Keep a running spec in the thread: id, name, description, triggers, permissions, env vars, execution steps, constraints, references/helpers, and verification.

Do not write until the skill is coherent enough to be useful. Include only the sections the skill actually needs.

## Direct writer contract

Use the harness file tools directly. Do not require a bundled script or CLI for skill creation.

For creates, write a new `catalog/skills/<skill-id>/SKILL.md` and any supporting files the skill actually needs. For edits, patch the existing files in place. Keep `catalog/skills/index.md` in sync when the skill catalog changes.

Completion for writes requires the intended files to exist, `SKILL.md` frontmatter to include the skill id, name, description, kind, permissions, and triggers as needed, and `index.md` to include the skill.

## Skill quality

Use `template-skill` as the reference shape when it exists in the catalog; it is copied as a disabled reference skill and should not be invoked. Keep generated skills self-contained and lean: use one source of truth, state permission boundaries, give ordered execution steps, and end steps with checkable completion criteria. Put branch-heavy detail in `references/*.md`. Operational helpers are allowed only when their permissions and verification are explicit.

## Safety constraints

Never create instructions that bypass permission checks, auto-approve the owner, read secret/env files, expose secret values, probe filesystem layout, default to destructive behavior, or hide external side effects. If requested, refuse that part and offer the safe version.

Editing bundled skills in `catalog/skills` may be overwritten on restart; new custom skills persist because bundled sync does not remove unrelated catalog folders.
