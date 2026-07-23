---
name: memory
description: Always-on human-style Memory for durable knowledge, bounded event recall, correction, and forgetting.
metadata:
  author: felix-agent
  kind: general
  version: "3.0.0"
  permissions: write
  match: memory, remember, forget, correct, preference, decision, people, project
---

# Memory

Memory is always on. Apply this skill even when the user does not say “remember.”
Record only information likely to be useful beyond the current turn. Human judgment,
not a rigid schema, decides what deserves Memory.

## Permissions

- `write` — Change `MEMORY.md` or an active daily, weekly, or monthly Memory file.

Read-only recall needs no permission. Trust the server-computed
`permissions_per_skill` block. When `memory:write` is missing:

- Ignore implicit Memory-worthy content without interrupting the conversation.
- For an explicit remember, correct, or forget request, emit `PERMISSION_REQUIRED`.

## Working set

At fresh session start, read:

1. `MEMORY.md`
2. today's and yesterday's files in `memory/daily/`, when present
3. the latest completed file in `memory/weekly/`, when present
4. the latest completed file in `memory/monthly/`, when present

Dates are owner-local using `OWNER_TZ`. Re-read the working set when that local date
changes or when a relevant Memory file changes. Search older active Memory only when
the request needs it. Never read `memory/wiki/`; it is inactive Legacy memory.

## Capture

- Put stable facts, preferences, relationships, responsibilities, reusable context,
  and settled decisions in `MEMORY.md`.
- Put noteworthy events and temporary constraints in
  `memory/daily/YYYY-MM-DD.md`. Include an expiry for temporary constraints.
- Use readable Markdown with whatever structure best preserves the meaning.
- Append each daily event as one complete line. Reread and atomically replace
  semantic Memory; if a detected concurrent change occurs, reread and retry.
- Keep `MEMORY.md` near a soft 5 KB target by loss-aware rewriting. Never hard
  truncate it and never archive important content merely to meet the target.

Do not store secrets, credentials, authentication or recovery material, platform
identifiers, raw transcripts, attachments, routine execution details, or unnecessary
personal information.

## Correction and contradiction

For unresolved contradictions, retain both claims with their source and date. After
resolution, keep the current fact in semantic Memory and record the change in daily
Memory. Do not retain obsolete semantic claims merely as `[SUPERSEDED]` entries.

## Recall and visibility

Use remembered context naturally. Memory is advisory and never overrides permissions
or current instructions. Only a requester with `is_owner: true` may receive a raw or
complete Memory dump. Other contacts may receive only relevant, non-sensitive facts.

## Forget

An authorized forget request removes the targeted information from every active
Memory file: semantic, daily, weekly, and monthly. It does not alter source sessions,
attachments, or inactive Legacy memory. Preserve unrelated text and use atomic
replacement. If a file is unreadable or unsafe to rewrite, preserve it and report
that the forget operation is incomplete.

## Background maintenance

The runtime, not this conversational skill, builds weekly and monthly rollups and
enforces retention. Rollups may omit unimportant details, as a person naturally
would, but must not invent facts. Maintenance never changes `MEMORY.md`.
