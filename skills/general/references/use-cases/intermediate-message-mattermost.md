# Intermediate message — Mattermost

Use this recipe when the agent needs to post a progress or intermediate message to a Mattermost thread during a turn (e.g., "Processing...", status updates, partial results).

## Prerequisites

- `MATTERMOST_URL` and `MATTERMOST_BOT_TOKEN` are already in the environment.
- `channel_id` and `root_post_id` are provided in the turn context's `source_thread_ref` (`conversation_id` and `root_message_id`).

## Procedure

1. Set the channel and root-post identifiers in the same bash block.
2. Post via the Mattermost REST API with `POST /api/v4/posts`.

## Post an intermediate text message

```bash
MATTERMOST_CHANNEL_ID="<channel_id>"
MATTERMOST_ROOT_POST_ID="<root_post_id>"
export MATTERMOST_CHANNEL_ID MATTERMOST_ROOT_POST_ID
MATTERMOST_MESSAGE="<message>"
export MATTERMOST_MESSAGE
PAYLOAD=$(node -e 'console.log(JSON.stringify({channel_id: process.env.MATTERMOST_CHANNEL_ID, root_id: process.env.MATTERMOST_ROOT_POST_ID, message: process.env.MATTERMOST_MESSAGE}))')
curl -sS -X POST \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$MATTERMOST_URL/api/v4/posts"
```

## Constraints

- No hard message-length limit enforced by the adapter; keep messages reasonable.
- The post is threaded automatically when `root_id` is set.
- Do not use source-API posting for the final reply — use `FELIX_REPLY` instead.
- Never upload secrets, credential files, or raw env files as artifacts.
