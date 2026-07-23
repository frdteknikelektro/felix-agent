# Workspace Folder Structure

## Layout

```
$WORKSPACE_DIR
│
├── AGENTS.md                      Felix behavior contract (boot-written)
├── CLAUDE.md                      Claude Code alias (identical copy)
├── PERSONALITY.md                 Global role, tone, and style (copy-if-absent)
├── WORKSPACE_FOLDER_STRUCTURE.md  This file
│
├── catalog/
│   └── contacts/
│       └── <source>/<user_id>.md        Per-contact config, allowed_permissions
│
├── .agents/
│   └── skills/
│       └── <skill_id>/SKILL.md          Skill definition (agentskills.io standard)
│
├── intake/
│   └── <source>/raw/                    Raw event staging (pre-session)
│
├── sessions/
│   └── <source>/<sid>/                  One directory per session
│       ├── session.json
│       ├── thread.json
│       ├── transcript.md
│       ├── INITIAL.md
│       ├── events/
│       ├── turns/
│       └── attachments/
│
├── approvals/
│   ├── _classify/                       Classification scratch dir
│   └── <thread_key>/<request_id>.json   Per-thread approval records
│
├── audit.jsonl                          Owner audit log (newline-delimited JSON)
│
├── index/
│   ├── thread-key/<source>/<thread_key>.json   Thread_key → session path
│   └── bot-messages/<source>/                  Bot message ID → thread_key (WhatsApp)
│
├── memory/                              Knowledge wiki (see memory skill for internals)
├── tasks/
│   ├── active/                          Exactly 1 task at a time
│   ├── backlog/
│   ├── blocked/
│   ├── done/
│   ├── cancelled/
│   └── paused/
│
├── projects/
│   └── <provider>/<namespace>/<repo>/   Checked-out repositories
│
└── runtime/                             Installed tools
    ├── bin/                             CLI tool symlinks/wrappers
    ├── npm/
    │   ├── lib/node_modules/            npm global packages
    │   └── bin/                         npm bin symlinks
    ├── tools/<name>/                    Per-tool installs
    └── python/                          pip --user installs
```

## Variables

| Variable | Example | Meaning |
|----------|---------|---------|
| `<source>` | `mattermost`, `discord`, `slack`, `whatsapp`, `telegram` | Message platform |
| `<user_id>` | `djpbhx7h778e78bz4sekjrxhue` | Platform-specific user identifier |
| `<skill_id>` | `github`, `install-tool`, `art-of-melancomedy` | Skill directory name |
| `<sid>` | `2026-06-08_03-41-53-202Z_mattermost_wr7oorm3bpgo7ydbw1wkbuf5fo_b4uookbgd7nr3kszaene8r7tgr` | Session directory name (`<timestamp>_<thread_key_safe>`) |
| `<thread_key>` | `mattermost:channelId:rootPostId` | Thread identifier (`<source>:<channel>:<root>`) |
| `<provider>` | `github`, `gitlab` | Git platform |
| `<namespace>` | `Atnic`, `frdteknikelektro` | Organization, group, or user scope |
| `<repo>` | `jala-web`, `felix-agent` | Repository name |
| `<name>` | `vercel`, `agent-browser` | Tool name under runtime/tools/ |
| `<request_id>` | `req-abc123` | Approval request identifier |

## Key Paths

| Path | Purpose |
|------|---------|
| `WORKSPACE_FOLDER_STRUCTURE.md` | Authoritative directory layout — read it once per session |
| `PERSONALITY.md` | Global role, tone, and communication style |
| `.agents/skills/<skill_id>/SKILL.md` | Skill definition (agentskills.io standard) |
| `catalog/contacts/<source>/<user_id>.md` | Per-contact config, `allowed_permissions` |
| `memory/wiki/index.md` | Knowledge wiki index — always read first |
| `sessions/<source>/<sid>/transcript.md` | Session transcript |
| `sessions/<source>/<sid>/INITIAL.md` | Per-session context (read once per session) |
| `tasks/active/` | Current active task |
| `projects/<provider>/<namespace>/<repo>/` | Checked-out repository |
| `runtime/bin/` | Installed CLI tools on PATH |

## Environment

- `$WORKSPACE_DIR` — always an absolute path.
- `$PATH` is prepended with `$WORKSPACE_DIR/runtime/bin:$WORKSPACE_DIR/runtime/npm/bin:$WORKSPACE_DIR/runtime/python/bin`.
- npm global prefix is `$WORKSPACE_DIR/runtime/npm` — set with `--prefix` by install-tool skill.

## Rules

1. **Never write outside `$WORKSPACE_DIR`.** Only the workspace volume is writable.
2. **Thread attachments go under `sessions/<sid>/attachments/`.** Never write to system temp.
3. **Clone repos to `projects/<provider>/<ns>/<repo>/`.** Never clone into sessions or tmp.
