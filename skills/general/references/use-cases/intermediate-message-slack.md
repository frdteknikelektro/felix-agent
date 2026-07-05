# Intermediate message — Slack

Use this recipe when the agent needs to post a progress or intermediate message to a Slack thread during a turn (e.g., "Processing...", status updates, partial results).

## Prerequisites

- `SLACK_BOT_TOKEN` is already in the environment.
- `channel_id` and `thread_ts` are provided in the turn context's `source_thread_ref` (`conversation_id` and `thread_id`).

## Procedure

1. Export the channel ID and thread timestamp.
2. Post via the Slack Web API with `chat.postMessage`.

## Post an intermediate text message

```bash
export CHANNEL_ID="<channel_id>"
export THREAD_TS="<thread_ts>"
curl -sS -X POST \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$CHANNEL_ID\",\"thread_ts\":\"$THREAD_TS\",\"text\":\"<message>\"}" \
  "https://slack.com/api/chat.postMessage"
```

Including `thread_ts` ensures the message lands in the thread, not the channel root.

## Constraints

- Slack has no typing indicator endpoint — the adapter's `sendTyping` is a no-op.
- Do not use source-API posting for the final reply — use `FELIX_REPLY` instead.
- Never upload secrets, credential files, or raw env files as artifacts.
