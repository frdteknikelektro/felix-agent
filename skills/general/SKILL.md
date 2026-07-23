---
name: general
description: Default assistant capability for conversation and ordinary File Collection or Session work when no specialized installed skill matches.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  match: general, help, info, explain, file, folder, directory, organize, rename, move, delete
---

## Permissions

No permissions required.

# General

Answer conversational requests directly and perform ordinary computer-assistant work for File Collections and Session work. Defer software Projects and specialized artifact types to their installed Skills.

## Execution

1. Check the skill index for a more specialized match. If one exists, defer to that skill.
2. For conversation, answer from available context. Ask one short question only when a missing fact materially changes the answer.
3. For filesystem work, read `WORKSPACE_FOLDER_STRUCTURE.md`, classify the artifact, and use its canonical area:
   - Generic persistent folder or non-software content → `files/<collection>/` (File Collection).
   - Request-specific intermediate work → `{thread_dir}/work/<work_name>/` (Session work).
   - Received input or a finished artifact for this conversation → `{thread_dir}/attachments/`.
   - Software → defer to `software-development`.
4. Before every user-work filesystem mutation, derive the complete target from the classification above, then apply the naming, collision, link-safety, and category-containment rules in `WORKSPACE_FOLDER_STRUCTURE.md`. Start persistent paths at `$WORKSPACE_DIR`; start Session paths at the exact current `thread_dir` supplied in the turn.
5. Inspect an existing target. Reuse only a clearly identical artifact; otherwise ask. Never invent a numeric suffix, merge a collision, or overwrite silently.
6. Create, edit, rename, move, or organize the narrow requested content, then verify and report its path relative to `$WORKSPACE_DIR`.
7. Before overwriting or deleting existing content, inspect the exact target and obtain explicit confirmation. Refuse hacking, credential access, permission bypass, external-path links, server disruption, and broad destructive commands.

Skills cannot override the Workspace placement contract. If no canonical category fits, stop and ask instead of inventing one.

## Conditional recipes

- **Record alias:** When a user asks to set, change, or remove an alias, read and follow [the alias recipe](references/use-cases/record-alias.md). Do not edit a contact before reading it.
- **Intermediate message (source-API posting):** When the agent needs to post a progress or intermediate message during a turn, read the recipe for the current source channel:
  - Mattermost: [intermediate-message-mattermost.md](references/use-cases/intermediate-message-mattermost.md)
  - Slack: [intermediate-message-slack.md](references/use-cases/intermediate-message-slack.md)
  - Discord: [intermediate-message-discord.md](references/use-cases/intermediate-message-discord.md)
  - WhatsApp: [intermediate-message-whatsapp.md](references/use-cases/intermediate-message-whatsapp.md)

  Always use `FELIX_REPLY` for the final reply. Source-API posting is only for intermediate/progress messages, file uploads, or supplementary content.
