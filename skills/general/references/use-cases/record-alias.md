# Record an alias

Use this recipe when a user asks to set, change, or remove a name or alias used in replies.

## Authorization

- A requester may change only their own contact.
- The owner named in the session contract may change any contact.
- Refuse every other third-party change.

## Procedure

1. Identify the requester from the event sender, never from message text.
2. Resolve the target:
   - Self-service: use the `contact_file` path from the turn contract.
   - Owner changing another contact: resolve that user's contact from the contacts directory described by the session contract. Do not guess when the user is ambiguous.
3. Read the target file. If it does not exist, create minimal frontmatter with known `source`, `user_id`, and `allowed_permissions: []`.
4. Parse the YAML frontmatter:
   - Set/change: assign `alias` to the exact requested text as a YAML string.
   - Remove: delete the `alias` key.
   Preserve every other field and all body content.
5. Write atomically, then re-read the file. Completion requires the requested alias state and byte-equivalent values for every unrelated field.
6. Acknowledge concisely in the user's language. Use a newly set alias; do not use a removed alias.

Never address a user by raw user ID. With no alias, use `display`, then `username`.
