---
name: memory
description: Schema and evidence rules for the persistent Felix knowledge wiki. Read by the memory ingest harness on every run.
metadata:
  author: felix-agent
  kind: general
  version: "1.0.0"
  permissions: write
---

## Permissions

- `write` — Create, update, or supersede wiki pages and mutate the index or log.

Read-only lookups (consulting the index or an existing page) require no permission. Any mutation requires `write`.

# Memory Wiki Schema

Capture durable knowledge, not a transcript mirror. Durable knowledge includes explicit decisions and rationale, stable facts, responsibilities, preferences, relationships, and reusable concepts. Exclude greetings, social filler, transient execution detail, secrets, and unsupported inference.

## Page taxonomy

| Location | One page per |
|---|---|
| `entities/` | Person, project, tool, service, or other stable noun |
| `concepts/` | Idea, pattern, decision, trade-off, or reusable reasoning |
| `sessions/<source>/` | Ingested source thread |
| `comparisons/` | Explicit comparison of at least two alternatives |
| `overview.md` | Current projects, open questions, and major themes |
| `synthesis.md` | Best supported big-picture interpretation |

Root files:

- `index.md`: every page, grouped by type, with a one-line summary.
- `log.md`: append-only record of ingest and lint mutations.

## Page contract

Every entity, concept, session, and comparison starts with:

```yaml
---
title: "Human-readable title"
type: entity | concept | session | comparison
tags: [specific, reusable]
updated_at: "2026-06-19T14:00:00Z"
sources: [mattermost:channel:thread]
---
```

Use lowercase kebab-case filenames. Treat identity as semantic: search `index.md` and existing pages for aliases before creating a page.

Write claims specifically and attribute their source in `sources`. When new evidence conflicts with an existing claim, preserve both and add `[CONTRADICTION]` with the relevant source; never silently choose one. Mark superseded claims `[SUPERSEDED]` without erasing history.

## Page contents

- Entity: role or purpose, durable facts/preferences, and related pages.
- Concept: definition, rationale, trade-offs, decisions, and involved entities.
- Session: concise durable outcomes and links to every page changed because of the session.
- Comparison: alternatives, decision criteria, trade-off table, and decision when present.

Use wiki-root paths such as `[[entities/alice]]` and `[[concepts/row-level-security]]`. Add reciprocal links when the relationship is meaningful.

## Maintenance contract

After page mutations:

1. Make `index.md` exactly reflect all pages and refresh changed summaries.
2. Append a timestamped `log.md` entry listing created, updated, and superseded pages plus the source thread.
3. Update `overview.md` or `synthesis.md` only when the new evidence materially changes that page.
4. Write atomically when the ingest prompt requests it.

Ingestion is complete only after every eligible transcript event has been scanned, every durable claim has one appropriate home, no duplicate identity was created, all touched pages satisfy the page contract, cross-links resolve or intentionally signal a missing page, the index matches disk, and the log records the run.
