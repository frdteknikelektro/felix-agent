---
name: memory
description: Schema and evidence rules for the persistent Felix memory system. Uses MEMORY.md for semantic memory and daily logs for episodic memory.
metadata:
  author: felix-agent
  kind: general
  version: "2.0.0"
  permissions: write
  match: memory, remember, recall, persistent knowledge
---

## Permissions

- `write` — Create, update, or supersede memory entries and write to daily logs.

Read-only lookups (consulting MEMORY.md or existing logs) require no permission. Any mutation requires `write`.

# Memory System

Capture durable knowledge, not a transcript mirror. Durable knowledge includes explicit decisions and rationale, stable facts, responsibilities, preferences, relationships, and reusable concepts. Exclude greetings, social filler, transient execution detail, secrets, and unsupported inference.

## Structure

```
~/
├── MEMORY.md                    # Semantic memory (durable facts)
└── memory/
    └── logs/
        ├── 2026-07-20.md        # Daily logs
        ├── 2026-07-21.md
        └── ...
```

- MEMORY.md lives at workspace root (not in a subdirectory)
- Logs organized by date in memory/logs/
- Auto-delete logs older than 7 days

## MEMORY.md Contract

MEMORY.md is plain text, no strict schema. Suggested structure:

```markdown
# Felix Memory

## About Owner
- [Name], [Role] at [Company]
- Language: [primary language], [secondary language]

## People
- [Name] — [Role], [Notable context]

## Projects
- [Project name]: [Tech stack], [Status], [Key decisions]

## Preferences
- [Category]: [Preference]

## Standing Decisions
- [Decision]: [Rationale]
```

- Flat structure, no nested directories
- One-line entries where possible
- Maximum target: ~5KB
- Felix can adapt format as needed

## Daily Logs Contract

Daily logs are plain text, no strict schema. Example:

```markdown
# Daily Log - YYYY-MM-DD

## Events
- [HH:MM] [Event description]
- [HH:MM] [Event description]

## Notes
- [Any additional context]
```

- Simple timestamped events
- Auto-delete after 7 days
- No permanent storage
- Felix can adapt format as needed

## Memory Update Rules

1. **Semantic updates**: When learning a new durable fact, update MEMORY.md
2. **Episodic updates**: When an event occurs, append to today's log
3. **Forgetting**: Trivial details (greetings, social filler, execution details) are not stored
4. **Contradictions**: Preserve both versions with `[CONTRADICTION]` tag
5. **Superseded**: Mark old info as `[SUPERSEDED]` without deleting

## Loading Strategy

1. Always load MEMORY.md at session start
2. Load today's and yesterday's logs automatically
3. Search older logs only when needed
4. Truncate MEMORY.md if it exceeds budget (keep file intact, truncate in context)

## Token Optimization

- Current wiki system: ~160KB loaded per session
- New memory system: ~10-20KB loaded per session
- Savings: ~87-94%

## Maintenance

After memory mutations:

1. Keep MEMORY.md under ~5KB
2. Append timestamped entries to today's log
3. Use atomic writes when updating MEMORY.md
4. Log cleanup runs automatically (7-day retention)
