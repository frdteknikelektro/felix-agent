# Record Alias

## When to use
Use this recipe when the user asks to be called by a specific name, nickname, or alias ("call me Bob", "my name is Alice", "address me as Dr. Smith"). Also use it when the user asks to stop using an alias ("don't call me that anymore", "just use my username", "forget my nickname").

## Workflow

1. Re-read the requester contact file — its path is in the session contract header (`Requester contact:`).
2. Parse the YAML frontmatter.
3. **To set an alias** — add or update `alias: <name>` in the frontmatter. Keep the value short; use exactly what the user provided.
4. **To remove an alias** — delete the `alias:` line, or set `alias:` with no value.
5. Preserve all other frontmatter fields (`source`, `user_id`, `display`, `username`, `allowed_permissions`, `notes`) exactly as they were.
6. Write the file back.
7. Acknowledge concisely in the user's language. Use the alias when acknowledging a set. Do not use an alias when acknowledging a removal.

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

**Set alias:**
User: "Call me Bob"
→ Read contact file → set `alias: Bob` → save → reply: "Got it, Bob."

**Change alias:**
User: "Actually call me Robert"
→ Read contact file → change `alias: Bob` to `alias: Robert` → save → reply: "Sure, Robert."

**Remove alias:**
User: "Stop calling me Bob, just use my username"
→ Read contact file → remove `alias:` line → save → reply: "Sure."

**Remove alias (empty value):**
User: "Forget my nickname"
→ Read contact file → delete `alias:` line → save → reply: "Done."

## Addressing the user

When the contact has an `alias` field, address the user by that alias in all replies. When the alias is empty or missing, use `display` if available, otherwise `username`. Never address a user by their raw user ID in a reply.
