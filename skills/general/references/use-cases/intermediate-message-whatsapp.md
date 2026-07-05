# Intermediate message — WhatsApp

Use this recipe when the agent needs to post a progress or intermediate message to a WhatsApp chat during a turn (e.g., "Processing...", status updates, partial results).

## Prerequisites

- `wacli` is available in the environment.
- `chat_jid` is provided in the turn context.

## Procedure

1. Use `wacli send text` to post intermediate messages.
2. The final reply MUST go through `FELIX_REPLY` — never use `wacli send text` for the final reply.

## Post an intermediate text message

```bash
wacli send text --to "<chat_jid>" --message "<message>"
```

## Bot name prefix (shared-number mode)

When the bot shares a WhatsApp number with its owner, **every** outgoing message must start with the `*[botName]*` prefix — including intermediate messages:

```bash
wacli send text --to "<chat_jid>" --message "*[BotName]*\n<message>"
```

When the bot has its own dedicated number, do NOT add any name prefix.

## Rate limiting

- All outbound sends (replies, reactions, intermediate messages) are rate-limited with a **6-second minimum gap** between any two sends.
- Sending too frequently will cause delays; batch information into fewer messages when possible.

## Constraints

- **Do NOT call `wacli send text` for your final reply.** Always use the `FELIX_REPLY` block — the harness sends it automatically. Using both causes duplicate messages.
- `wacli send text` may only be used for intermediate/progress messages **before** the final `FELIX_REPLY`.
- WhatsApp cannot edit messages in-place. An "edit" sends a new message instead.
- WhatsApp uses its own formatting: `*bold*`, `_italic_`, `` `code` ``. Do NOT use Markdown.
- Never upload secrets, credential files, or raw env files as artifacts.
