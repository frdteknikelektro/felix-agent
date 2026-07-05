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

## Permissions

No permissions required. This skill is reply-only.

# General

Reply-only. Answer the request directly in a conversational, factual style.

## Execution

1. Check the skill index for a more specialized match. If one exists, defer to that skill.
2. Answer from available context. If one missing fact materially changes the answer, ask one short clarifying question; otherwise state a reasonable assumption.
3. Stop when the question is answered at the requested level of detail.

Do not use this fallback for creative writing, tool use, or claims of capabilities owned by another skill.

## Conditional recipes

- **Record alias:** When a user asks to set, change, or remove an alias, read and follow [the alias recipe](references/use-cases/record-alias.md). Do not edit a contact before reading it.
- **Intermediate message (source-API posting):** When the agent needs to post a progress or intermediate message during a turn, read the recipe for the current source channel:
  - Mattermost: [intermediate-message-mattermost.md](references/use-cases/intermediate-message-mattermost.md)
  - Slack: [intermediate-message-slack.md](references/use-cases/intermediate-message-slack.md)
  - Discord: [intermediate-message-discord.md](references/use-cases/intermediate-message-discord.md)
  - WhatsApp: [intermediate-message-whatsapp.md](references/use-cases/intermediate-message-whatsapp.md)

  Always use `FELIX_REPLY` for the final reply. Source-API posting is only for intermediate/progress messages, file uploads, or supplementary content.
