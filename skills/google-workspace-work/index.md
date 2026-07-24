# google-workspace-work

Google Workspace operations for a second, separate Google account via the `gog`
CLI `work` OAuth client — Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms,
Contacts, Tasks, Admin, Chat, YouTube, Maps, Photos, Meet. Extends the base
`google-workspace` skill; every command runs with `--client work`.

## Files

- `SKILL.md` — Overlay definition; documents only the `--client work` difference

Operation references live in the base skill:

- `../google-workspace/references/setup.md` — First-time owner setup guide
- `../google-workspace/references/auth-flow.md` — Headless OAuth, re-authorization, security
- `../google-workspace/references/account-resolution.md` — Multi-account selection rules
- `../google-workspace/references/commands.md` — Intent → gog command mapping
- `../google-workspace/references/examples.md` — Example conversations with permission checks

## Permissions

- `read` — Read-only operations (scoped per service)
- `write` — Mutations (scoped per service)

Grants are stored under this skill id (`google-workspace-work`), isolated from
the base `google-workspace` skill.
