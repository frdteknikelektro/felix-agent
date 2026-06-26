---
id: usage-report
name: Usage Report
description: Report Felix token usage — today, this week, this month, all-time, with per-contact, per-source, per-model, and per-thread breakdowns.
version: 1
enabled: true
kind: operational
permissions:
  - usage.read
match:
  - token usage, tokens used, how many tokens, usage report
  - usage today, usage this week, weekly usage, monthly usage
  - how much have I used, token spend, token consumption
---

# Usage Report

## Purpose
Report token consumption recorded by Felix across every LLM turn. Reads the
daily-partitioned usage log and prints totals + breakdowns for today, this week,
this month, and all-time.

## When to use
- Someone asks how many tokens were used (today / this week / this month / total)
- Someone asks for a usage breakdown by contact, source, model, or thread

## Out of scope
- Dollar cost (only token counts are tracked — no pricing)
- Changing or resetting usage data (read-only)
- Per-message live counters (use the owner console dashboard for live "tokens today")

## Permission
This skill requires the `usage.read` permission. Usage data is owner-only — if the
requester is not pre-authorized, emit a `PERMISSION_REQUIRED` block for
`usage-report` / `usage.read` per the standard permission flow before running.

## Data source
Usage records live at `${WORKSPACE_DIR}/usage/<YYYY-MM-DD>.jsonl`, one JSON object
per turn:

```
{ at, source, contact_id, thread_key, harness, model, input, output, cache_read, cache_write, total }
```

Day/week/month boundaries follow the `USAGE_TZ` environment variable (default UTC,
ISO week starting Monday). Both `WORKSPACE_DIR` and `USAGE_TZ` are already in the
environment — do not redefine them.

## Workflow

Run the bundled reporter. Pass an optional window argument; omit it for all windows.

```bash
# All windows (today + week + month + all-time):
node "${WORKSPACE_DIR}/catalog/skills/usage-report/report.mjs"

# A single window:
node "${WORKSPACE_DIR}/catalog/skills/usage-report/report.mjs" today
node "${WORKSPACE_DIR}/catalog/skills/usage-report/report.mjs" week
node "${WORKSPACE_DIR}/catalog/skills/usage-report/report.mjs" month
node "${WORKSPACE_DIR}/catalog/skills/usage-report/report.mjs" all
```

The script prints a formatted markdown report. Relay it to the user, trimming to
what they asked for (e.g. only "today" if that's the question). If the requested
window has no data, say so plainly.

## Checks
- Always resolve paths from `${WORKSPACE_DIR}` — never hardcode workspace paths.
- Read-only: never modify, delete, or write usage files.
- If the `usage/` directory is empty or missing, report "No usage recorded yet."
- Only the owner (or a contact granted `usage.read`) may see this data.
- Token counts only — never invent dollar costs.
