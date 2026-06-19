---
id: memory
name: Memory Wiki
description: Conventions for maintaining the Felix knowledge wiki. Read by the ingest harness on every run.
permissions:
  - write
---

## What this is

This is a personal, interlinked knowledge wiki maintained by an LLM. Every conversation
Felix has is ingested here — entities, concepts, decisions, preferences, and facts are
extracted and woven into a persistent, compounding knowledge base.

The wiki is meant to be read by both humans (via Obsidian or any markdown editor) and
by Felix (as context injected into future conversations).

## Directory structure

| Directory | Purpose |
|---|---|
| `entities/` | People, projects, tools, services — the nouns of the domain |
| `concepts/` | Ideas, patterns, architectural decisions, trade-offs — the verbs and reasoning |
| `sessions/` | Per-source-thread conversation summaries — one page per ingested transcript |
| `comparisons/` | Side-by-side analyses — only when two or more things are explicitly compared |
| `overview.md` | Synthesis page pulling threads together — active projects, open questions, major themes |
| `synthesis.md` | The evolving thesis — your best big-picture understanding of what's happening |

Two special files exist at the root:
- `index.md` — a catalog of every page with a one-line summary, grouped by type
- `log.md` — an append-only timeline of every ingest, lint, and query operation

## Page conventions

Every wiki page starts with YAML frontmatter:

```yaml
---
title: "Human-readable title"
type: entity | concept | session | comparison
tags: [tag1, tag2]
updated_at: "2026-06-19T14:00:00Z"
sources: [mattermost:channel:thread, ...]
---
```

### Entity pages (`entities/`)

One page per person, project, tool, or service. Collect facts, preferences,
responsibilities, and relationships. Template:

```markdown
---
title: "Alice"
type: entity
tags: [person, devops]
updated_at: "2026-06-19T14:00:00Z"
sources: [mattermost:channel:thread]
---

# Alice

## Role
DevOps lead.

## Preferences
- Always deploy to us-west-2, never us-east-1.

## Related
- [[concepts/multi-tenant-rls]] — proposed the migration
- [[entities/auth-service]] — maintains this service
```

### Concept pages (`concepts/`)

One page per idea, pattern, architectural decision, or trade-off. These pages
explain the reasoning, not just the what. Template:

```markdown
---
title: "Multi-tenant RLS"
type: concept
tags: [database, postgres, architecture]
updated_at: "2026-06-19T14:00:00Z"
sources: [mattermost:channel:thread]
---

# Multi-tenant Row-Level Security

## What it is
Using PostgreSQL row-level security to isolate tenant data in a single database.

## Why we chose it
- Single Postgres instance, no per-tenant databases.
- Simpler backup and migration story.
- Trade-off: all tenants share the same connection pool.

## Related
- [[entities/auth-service]] — implements the RLS policies
- [[comparisons/pgvector-vs-chromadb]] — related database decision
```

### Session pages (`sessions/`)

One page per ingested source transcript. Organized by source platform.
Summarize what was discussed and link to entities and concepts mentioned.

### Comparison pages (`comparisons/`)

Side-by-side analyses. Only create these when two or more things are explicitly
compared in a conversation. Include a decision matrix or trade-off table.

## Cross-linking

Use `[[path/to/page]]` wikilinks to connect pages. When updating a page and
discovering a connection to another concept, add a link. If the target page
doesn't exist yet, the link signals that a page is needed.

Prefer relative paths from the wiki root: `[[entities/alice]]`, `[[concepts/multi-tenant-rls]]`.

## index.md format

Grouped by type with one line per page:

```markdown
# Wiki Index

## Entities
- [[entities/alice]] — DevOps lead, prefers us-west-2 for production (3 sources)

## Concepts
- [[concepts/multi-tenant-rls]] — Row-level security strategy for multi-tenant database (2 sources)

## Sessions
- [[sessions/mattermost/2026-06-19_auth-migration]] — Migrated auth service to JWT tokens

## Comparisons
- [[comparisons/pgvector-vs-chromadb]] — Database decision matrix for vector storage
```

## log.md format

Append-only, each entry is a timestamped heading followed by a bullet list:

```markdown
## 2026-06-19T14:05:00Z | ingest | mattermost:channel:thread
- Created: [[entities/alice]] — extracted from session
- Updated: [[concepts/multi-tenant-rls]] — added pgvector migration detail
- Updated: [[overview]] — added active migration project
- Index: added 3 entries, updated 1
```

## Rules of thumb

1. **Create liberally.** A thin page with frontmatter and one sentence is better than no page.
   Future conversations will fill it in. Never silently discard information — if it was said,
   it belongs in the wiki.

2. **Update, don't duplicate.** Read the existing page before writing.
   If a page already exists for an entity or concept, add to it rather than creating a duplicate.

3. **Be specific.** "The deployment pipeline uses GitHub Actions with self-hosted runners"
   is better than "They use CI/CD." Sources (which conversations contributed) matter.

4. **Link aggressively.** Every entity page should link to relevant concept pages.
   Every concept page should link to the entities involved. The wiki's value is in its connections.

5. **Contradictions are valuable.** If a new conversation contradicts an existing fact,
   flag it with a `[CONTRADICTION]` note and link both pages. Do not silently overwrite.

6. **overview.md and synthesis.md are living documents.** Update them whenever a new
   conversation shifts your understanding of what's important or what the big picture is.
