---
name: 9router
description: 9Router gateway setup and capability routing. Use when the user mentions 9Router or NINEROUTER_URL, or asks to call an AI capability through the configured 9Router gateway.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  match: 9router, NINEROUTER_URL
---

## Permissions

No permissions required. Setup and model discovery are read-only; capability calls use the gateway's own auth.

# 9Router

Treat 9Router as a gateway: verify it, discover a compatible model, then follow the capability contract.

## Execution

1. Require `NINEROUTER_URL`. Use `NINEROUTER_KEY` only when gateway authentication is enabled. Never print either value.
2. Verify the gateway:

   ```bash
   curl -fsS "${NINEROUTER_URL%/}/api/health"
   ```

   Continue only after a successful response containing `"ok": true`.
3. For a setup-only request, provide the minimum environment configuration and stop:

   ```bash
   export NINEROUTER_URL="http://localhost:20128"
   export NINEROUTER_KEY="sk-..." # omit when authentication is disabled
   ```
4. For a capability request, fetch the matching upstream `SKILL.md` below and read it completely before making the request.
5. Discover models from the capability endpoint and use an exact `data[].id`. Completion requires either a valid capability response or an actionable gateway error; do not invent a result.

## Capability contracts

| Capability | Model discovery | Contract |
|---|---|---|
| Chat / code | `/v1/models` | [9router-chat](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-chat/SKILL.md) |
| Image generation | `/v1/models/image` | [9router-image](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-image/SKILL.md) |
| Text-to-speech | `/v1/models/tts` | [9router-tts](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-tts/SKILL.md) |
| Speech-to-text | `/v1/models/stt` | [9router-stt](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-stt/SKILL.md) |
| Embeddings | `/v1/models/embedding` | [9router-embeddings](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-embeddings/SKILL.md) |
| Web search | `/v1/models/web` | [9router-web-search](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-search/SKILL.md) |
| Web fetch | `/v1/models/web` | [9router-web-fetch](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-fetch/SKILL.md) |

```bash
MODEL_PATH="/v1/models" # replace from the table
if [ -n "${NINEROUTER_KEY:-}" ]; then
  curl -fsS -H "Authorization: Bearer $NINEROUTER_KEY" "${NINEROUTER_URL%/}${MODEL_PATH}"
else
  curl -fsS "${NINEROUTER_URL%/}${MODEL_PATH}"
fi
```

Entries with `owned_by: "combo"` provide fallback routing. Web entries use `kind` to distinguish search from fetch.

## Failure routing

- `401`: the key is missing or stale.
- `400 Invalid model format`: rediscover models for the selected capability.
- `503 All accounts unavailable`: honor `retry-after`; otherwise ask the user to add an available provider account.
