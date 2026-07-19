---
name: scheduler
description: Schedule recurring tasks and one-shot alarms/reminders via natural language
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: scheduler.*
  match: jadwalkan, schedule, periodik, otomatis, alarm, reminder, scheduler, timer
---

# Scheduler Skill

Manage scheduled tasks and one-shot alarms/reminders by writing JSON files directly.

Required permissions: `scheduler.*`

## Permissions

- `scheduler.list` — List all jobs
- `scheduler.read` — Read a specific job
- `scheduler.write` — Create, update, or delete jobs

## Job File Schema

Write job files to `workspace/scheduler/jobs/{uuid}.json`:

```json
{
  "id": "uuid-v4",
  "name": "daily-report",
  "prompt": "Generate daily report and send to Telegram",
  "schedule": { "type": "cron", "expression": "0 8 * * *" },
  "run_once": false,
  "status": "active",
  "output": "ringkas",
  "retry": { "max_attempts": 3, "backoff_ms": 5000 },
  "permissions": ["github.write"],
  "created_by": { "source": "telegram", "user_id": "1706579477" },
  "next_run_at": "2026-07-20T08:00:00.000Z",
  "last_run_at": null,
  "created_at": "2026-07-19T10:00:00.000Z"
}
```

## Schedule Types

**Cron:** `"0 8 * * *"` (daily), `"0 */6 * * *"` (every 6h), `"30 9 * * 1-5"` (weekdays 09:30)
**Interval:** milliseconds value (e.g., `3600000` = hourly)

## Calculate next_run_at

**Cron:** Find next matching time. **Interval:** `Date.now() + intervalMs`

## CRUD Operations

**Create:** Write JSON to `workspace/scheduler/jobs/{uuid}.json`
**List:** Read all `.json` files from `workspace/scheduler/jobs/`
**Read:** Read `workspace/scheduler/jobs/{id}.json`
**Update:** Read, modify, write back
**Delete:** Delete `workspace/scheduler/jobs/{id}.json`

## Output Modes

- `ringkas` (default): Status + 1-2 sentence summary
- `detail`: Status + full agent output
- `silent`: No delivery (file-only logging)

## One-Shot Mode

Set `run_once: true` for alarms/reminders. Engine auto-marks as `completed` after success.

## Confirmation Flow

Confirm before creating: task description, schedule (cron + human-readable), inherited permissions.

## Prompt Validation

**Too vague (ask):** "jadwalkan backup", "cek server"
**Detailed enough:** "jadwalkan backup database PostgreSQL ke /backups setiap malam jam 2"

## Execution Logs

Logs at `workspace/scheduler/logs/{jobId}/{executionId}.json`

## List Format

Group by status: Active → Paused → Failed/completed. Format: name, schedule, status, next run.

## Edit Flow

Edit only schedule. For task changes, delete and recreate.

## Delete

Confirm with name, schedule, last run. Hard delete (no soft delete for MVP).
