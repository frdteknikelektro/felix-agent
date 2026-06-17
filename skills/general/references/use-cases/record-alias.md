# Record Alias

## When to use
Use this recipe when the user asks to be called by a specific name, nickname, or alias ("call me Bob", "my name is Alice", "address me as Dr. Smith"). Also use it when the user asks to stop using an alias ("don't call me that anymore", "just use my username", "forget my nickname").

**Only the requester can set or remove their own alias.** If someone asks you to set an alias for a *different* user, you must refuse unless the requester is the owner (identified in the session contract header under `## Owner`). The owner may set or remove any user's alias.

## Workflow

1. Identify the requester from the event sender (not from the text — the requester is always the person who sent the message).
2. Re-read the requester's own contact file — its path is in the session contract header (`Requester contact:`). Do NOT read or modify any other user's contact file.
3. Parse the YAML frontmatter.
4. **To set an alias** — add or update `alias: <name>` in the requester's frontmatter. Keep the value short; use exactly what the user provided.
5. **To remove an alias** — delete the `alias:` line from the requester's frontmatter, or set `alias:` with no value.
6. Preserve all other frontmatter fields (`source`, `user_id`, `display`, `username`, `allowed_permissions`, `notes`) exactly as they were.
7. Write the file back.
8. Acknowledge concisely in the user's language. Use the alias when acknowledging a set. Do not use an alias when acknowledging a removal.

## Contact file format

Minimal contact with alias:

```yaml
---
source: mattermost
user_id: abc123
alias: Bob
allowed_permissions: []
---
```

## New user with no contact file yet

If the contact file does not exist, create it with minimal frontmatter:

```yaml
---
source: mattermost
user_id: <id from Requester contact path>
alias: <name>
allowed_permissions: []
---
```

Do not guess `display` or `username` — only include fields you have values for.

## Examples

**Set alias (self):**
User: "Call me Bob"
→ Read requester's own contact file → set `alias: Bob` → save → reply: "Got it, Bob."

**Change alias (self):**
User: "Actually call me Robert"
→ Read requester's own contact file → change `alias: Bob` to `alias: Robert` → save → reply: "Sure, Robert."

**Remove alias (self):**
User: "Stop calling me Bob, just use my username"
→ Read requester's own contact file → remove `alias:` line → save → reply: "Sure."

**Remove alias (self, empty value):**
User: "Forget my nickname"
→ Read requester's own contact file → delete `alias:` line → save → reply: "Done."

**Refuse alias for another user (non-owner):**
User: "Call @frdinawan Bapak"
→ Requester is not the owner → reply: "I can only set an alias for you. Only the owner can set aliases for other users."

**Set alias for another user (owner):**
User (owner): "Set @jihad's alias to Prabowo"
→ Requester is the owner (confirmed in session contract header) → read @jihad's contact file → set `alias: Prabowo` → save → reply: "Done."

## Addressing the user

When the contact has an `alias` field, address the user by that alias in all replies. When the alias is empty or missing, use `display` if available, otherwise `username`. Never address a user by their raw user ID in a reply.
