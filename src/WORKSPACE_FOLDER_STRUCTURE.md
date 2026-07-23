# Workspace Folder Structure

## Layout

```
$WORKSPACE_DIR
│
├── AGENTS.md                      Felix behavior contract (boot-written)
├── CLAUDE.md                      Claude Code alias (identical copy)
├── PERSONALITY.md                 Global role, tone, and style (copy-if-absent)
├── MEMORY.md                      Durable semantic Memory (created if absent)
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
│       ├── work/                         Request-specific intermediate work
│       └── attachments/                  Received inputs and finished deliverables
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
├── memory/                              Active and inactive persistent memory
│   ├── daily/                           Recent owner-local episodic Memory
│   ├── weekly/                          Completed weekly rollups (Monday start)
│   ├── monthly/                         Completed monthly rollups
│   └── wiki/                            Inactive Legacy memory (preserved, never read)
├── tasks/
│   ├── active/                          Exactly 1 task at a time
│   ├── backlog/
│   ├── blocked/
│   ├── done/
│   ├── cancelled/
│   └── paused/
│
├── files/
│   └── <collection>/                     Persistent non-software File Collection
│
├── projects/
│   ├── local/
│   │   └── <project>/                    Persistent Project without a remote
│   └── <provider>/<namespace>/<repo>/    Hosted repository
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
| `<project>` | `cost-dashboard` | Local Project name |
| `<collection>` | `invoices` | Persistent non-software collection name |
| `<work_name>` | `pdf-conversion` | Request-specific Session work name |
| `<name>` | `vercel`, `agent-browser` | Tool name under runtime/tools/ |
| `<request_id>` | `req-abc123` | Approval request identifier |

## Key Paths

| Path | Purpose |
|------|---------|
| `WORKSPACE_FOLDER_STRUCTURE.md` | Authoritative directory layout — read it once per session |
| `PERSONALITY.md` | Global role, tone, and communication style |
| `.agents/skills/<skill_id>/SKILL.md` | Skill definition (agentskills.io standard) |
| `catalog/contacts/<source>/<user_id>.md` | Per-contact config, `allowed_permissions` |
| `MEMORY.md` | Durable semantic Memory — part of the fresh-session working set |
| `memory/daily/` | Recent episodic Memory by owner-local date |
| `memory/weekly/` | Completed weekly rollups, named by Monday start |
| `memory/monthly/` | Completed monthly rollups |
| `sessions/<source>/<sid>/transcript.md` | Session transcript |
| `sessions/<source>/<sid>/INITIAL.md` | Per-session context (read once per session) |
| `sessions/<source>/<sid>/work/<work_name>/` | Request-specific intermediate Session work |
| `sessions/<source>/<sid>/attachments/` | Received inputs and finished conversational deliverables |
| `tasks/active/` | Current active task |
| `files/<collection>/` | Persistent non-software File Collection |
| `projects/local/<project>/` | Persistent Local Project without a remote |
| `projects/<provider>/<namespace>/<repo>/` | Hosted Project |
| `runtime/bin/` | Installed CLI tools on PATH |
| `runtime/bin/felix-workspace-path` | Canonical user-work target resolver installed at boot |

## Environment

- `$WORKSPACE_DIR` — always an absolute path.
- `$PATH` is prepended with `$WORKSPACE_DIR/runtime/bin:$WORKSPACE_DIR/runtime/npm/bin:$WORKSPACE_DIR/runtime/python/bin`.
- npm global prefix is `$WORKSPACE_DIR/runtime/npm` — set with `--prefix` by install-tool skill.

## Rules

This layout is an **exhaustive placement contract** for agent-created directories, not an example. Skills and users may create descendants inside a canonical area, but must not introduce an undocumented Workspace-root category.

1. **Never write outside `$WORKSPACE_DIR`.** Resolve the real target or its nearest existing parent first; symbolic and hard links must not escape the Workspace.
2. **Classify before creating.** Software belongs in a Local or Hosted Project, persistent non-software content in a File Collection, request-specific intermediates in Session work, and conversational inputs or finished deliverables in Session attachments.
3. **Default generic folders to File Collections.** Use `files/<collection>/` unless the request clearly identifies software or Session work.
4. **Clone repos to `projects/<provider>/<namespace>/<repo>/`.** Never clone into Sessions, File Collections, or temporary directories.
5. **Create no-remote software under `projects/local/<project>/`.** When a recognized GitHub or GitLab remote later identifies an unambiguous absent destination, promote the complete Project automatically without merging or overwriting.
6. **Use readable safe names.** Convert human-created artifact names and non-project descendants to lowercase kebab-case, preserve safe Unicode letters, numbers, and lowercase file extensions, and reject separators, controls, empty names, `.` and `..`. Project descendants may retain names required by their language or tooling.
7. **Inspect collisions.** Reuse only a clearly identical target; otherwise ask. Never invent numeric suffixes, merge directories, or overwrite a collision silently.
8. **Skills cannot override placement.** A Skill-specific path must remain inside the canonical area for its artifact.
9. **No automatic legacy migration or Hosted Project demotion.** Existing unknown folders remain untouched until an explicit migration task.
10. **Resolve every user-work mutation through `felix-workspace-path`.** Select one complete artifact category, use the returned absolute target, and stop if validation rejects the category shape, active Session binding, relative path, link safety, or real-path containment.
