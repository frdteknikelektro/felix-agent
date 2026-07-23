---
name: google-workspace
description: >-
  Google Workspace operations via gog CLI — search email, manage calendar, edit
  docs, list files, send messages, and administer users across Gmail, Drive,
  Calendar, Docs, Sheets, Slides, Forms, Contacts, Tasks, Admin, Chat, YouTube,
  Maps, Photos, Meet, Classroom, Groups, Keep.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: read.*, write.*
  match: gmail, email, calendar, drive, docs, sheets, slides, forms, contacts, tasks, google workspace, gog, google admin, google chat, youtube, google photos, google keep, google meet, google classroom, google groups, google maps
env:
  - key: GOOGLE_CLIENT_ID
    description: OAuth client ID used by gog credentials templates.
    secret: true
  - key: GOOGLE_CLIENT_SECRET
    description: OAuth client secret used by gog credentials templates.
    secret: true
  - key: GOG_HOME
    description: Persistent gog configuration and token directory.
    default: /home/node/.config/gogcli
  - key: GOG_KEYRING_BACKEND
    description: Keyring backend for headless containers.
    default: file
  - key: GOG_KEYRING_PASSWORD
    description: Password for the file keyring backend.
    secret: true
---

# Google Workspace

All operations through the `gog` CLI with `--json` output.

## Permissions

- `read` — read-only, scoped per service (`read.gmail`, `read.drive`).
- `write` — mutations, scoped per service (`write.gmail`, `write.drive`).

Wildcard: `read.*` / `write.*` covers all services. Append `--readonly` unless
the contact grants `write.<requested-service>` or `write.*`; a write grant for
another service never authorizes mutation.

## Execution

1. **Resolve permissions.**
   Read the grants for this skill and the requested operation before checking
   auth, discovering a schema, or executing any command. If the requested
   service/action is not granted, stop and request the missing permission.
   Completion: the operation is authorized or explicitly blocked.

2. **Check auth.**
   Run `gog auth list --check --json`. If no account is authorized, read
   `references/setup.md` and guide the owner through first-time setup.
   Completion: account confirmed authorized, or setup initiated.

3. **Execute the command.**
   Identify the correct `gog <service> <command>` — consult
   `references/commands.md` for the mapping, or run `gog schema --json` to
   discover flags when the command is unknown. Run with `--json`. Before a
   Drive/Photos download or any file attachment output, read
   `WORKSPACE_FOLDER_STRUCTURE.md`, classify the local artifact, and derive its
   complete canonical path: current deliverables use
   `{thread_dir}/attachments/<filename>`, intermediates use
   `{thread_dir}/work/<work_name>/`, and persistent non-software content uses
   `$WORKSPACE_DIR/files/<collection>/`. Apply the corresponding naming,
   collision, link-safety, and containment rules from that contract before
   passing the derived target to `--out`.
   Completion: result delivered — inline for ≤30 lines, file attachment for larger.

Automated wrappers can use `scripts/run-workflow.mjs` to preserve this ordering:
the permission check runs first, followed by auth, optional schema discovery, and
only then the requested command.

4. **Confirm destructive operations.**
   For delete, trash, purge, remove, or create-user: preview the target, ask the
   user for confirmation, then execute.
   Completion: user confirmed, result reported.

5. **Handle errors.**
   On auth errors: re-authorize via `gog auth add <email> --manual` (see
   `references/auth-flow.md`). On other errors: report stderr with actionable
   guidance.
   Completion: error resolved or reported.

## Branch reference

### Auth and accounts
Read `references/auth-flow.md` for headless OAuth, re-authorization, and
multi-account management. Read `references/account-resolution.md` when account
selection is ambiguous.

### First-time setup
Read `references/setup.md` when no Google account is authorized yet.

### Service commands
Read `references/commands.md` when you need the exact `gog` command for a
Google Workspace operation.

### Example conversations
Read `references/examples.md` when you need to see how a user request maps to a
gog command and permission check.

## Constraints

- Never log or expose OAuth tokens, refresh tokens, or credential files.
- When multiple accounts exist and the user doesn't specify, ask which to use.
