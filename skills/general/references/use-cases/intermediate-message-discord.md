# Intermediate message — Discord

Use this recipe when the agent needs to post a progress or intermediate message to a Discord channel/thread during a turn (e.g., "Processing...", status updates, partial results).

## Prerequisites

- `DISCORD_BOT_TOKEN` is already in the environment.
- `channel_id` is provided in the turn context.

## Procedure

1. Export the channel ID.
2. Post via the Discord REST API.

## Post an intermediate text message

```bash
export CHANNEL_ID="<channel_id>"
curl -sS -X POST \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"<message>"}' \
  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"
```

## Constraints

- **Max 2000 characters per message.** Split longer content into multiple messages, breaking on newlines near the limit.
- Do not use source-API posting for the final reply — use `FELIX_REPLY` instead.
- Never upload secrets, credential files, or raw env files as artifacts.
