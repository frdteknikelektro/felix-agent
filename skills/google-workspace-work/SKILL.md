---
name: google-workspace-work
description: >-
  Second, isolated Google account via the gog `work` OAuth client. Same
  Gmail/Calendar/Drive/Docs/Sheets/Slides/Forms/Contacts/Tasks/Admin operations
  as base google-workspace, but every command runs with --client work, kept
  separate from the default account.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: read.*, write.*
  match: work gmail, work email, work calendar, work drive, work docs, work sheets, work slides, work forms, work contacts, work tasks, work google, google workspace work, work workspace, work gog
env:
  - key: GOOGLE_WORK_CLIENT_ID
    description: OAuth client ID for the work Google Cloud project (gog --client work).
    secret: true
  - key: GOOGLE_WORK_CLIENT_SECRET
    description: OAuth client secret for the work Google Cloud project (gog --client work).
    secret: true
---

# Google Workspace (work account)

Operate a **second, separate Google account** through the `gog` CLI. This skill
extends the base `google-workspace` skill. Every operation, permission policy,
destructive-operation gate, account-resolution rule, and command reference is
identical — this file documents only what is different.

**The only difference: every `gog` invocation MUST include `--client work`.**
That routes to the `work` OAuth client's own credential and token bucket, kept
fully separate from the default (personal) client. A grant on *this* skill id
(`google-workspace-work:*`) never authorizes the base `google-workspace` skill,
and vice versa — the two accounts are isolated at both the credential and the
permission layer.

Do not duplicate operation documentation. Read the base skill's references for
the actual commands.

## When to use

Activate when the user asks to operate specifically on their **work** Google
account. Trigger words include "work gmail", "work calendar", "work drive",
"work google", "google workspace work".

## Out of scope

- The default/personal Google account — route to the base `google-workspace` skill.
- Operations not covered by the `gog` CLI.

## Permissions

Same permission policy as the base `google-workspace` skill; Felix stores grants
under **this** skill id, so they are independent of the base skill.

- `read` — read-only, scoped per service (`read.gmail`, `read.drive`).
- `write` — mutations, scoped per service (`write.gmail`, `write.drive`).

Wildcard `read.*` / `write.*` covers all services. Append `--readonly` unless the
contact grants `write.<requested-service>` or `write.*`.

## Execution

Follow the base skill's execution steps in
[../google-workspace/SKILL.md](../google-workspace/SKILL.md), with two overrides:

1. **Auth check** — `gog auth list --check --json --client work`. If no account
   is authorized on the work client, read
   [../google-workspace/references/setup.md](../google-workspace/references/setup.md)
   and guide first-time setup (the setup wizard authorizes the work client when
   `GOOGLE_WORK_CLIENT_ID` / `GOOGLE_WORK_CLIENT_SECRET` are set).
2. **Every command** — prepend `--client work`, e.g.
   `gog --client work --account you@work.example gmail search 'is:unread' --json`.

## Branch reference

Read the base skill's references — they apply unchanged apart from the mandatory
`--client work` flag:

- [../google-workspace/references/setup.md](../google-workspace/references/setup.md) — first-time owner setup.
- [../google-workspace/references/auth-flow.md](../google-workspace/references/auth-flow.md) — headless OAuth, re-authorization, multi-account.
- [../google-workspace/references/account-resolution.md](../google-workspace/references/account-resolution.md) — account selection within the work client.
- [../google-workspace/references/commands.md](../google-workspace/references/commands.md) — intent → gog command mapping.
- [../google-workspace/references/examples.md](../google-workspace/references/examples.md) — example conversations.

## Constraints

- Never log or expose OAuth tokens, refresh tokens, or credential files.
- Never run a work-account command without `--client work`.
- When multiple accounts exist on the work client and the user doesn't specify, ask which to use.
