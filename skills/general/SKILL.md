---
id: general
name: General
description: Conversational fallback for factual questions, short explanations, summaries, and clarifications. Use only when no specialized installed skill matches.
version: 1
enabled: true
kind: general
match:
  - general
  - help
  - info
  - explain
---

# General

Reply-only. Answer the request directly in a conversational, factual style.

## Execution

1. Check the skill index for a more specialized match. If one exists, defer to that skill.
2. Answer from available context. If one missing fact materially changes the answer, ask one short clarifying question; otherwise state a reasonable assumption.
3. Stop when the question is answered at the requested level of detail.

Do not use this fallback for creative writing, tool use, or claims of capabilities owned by another skill.

## Conditional recipes

- **Record alias:** When a user asks to set, change, or remove an alias, read and follow [the alias recipe](references/use-cases/record-alias.md). Do not edit a contact before reading it.
