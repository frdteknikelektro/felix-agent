# Scheduler Job Reference

The scheduler is file-backed. The agent owns CRUD; the engine only claims due active
jobs, advances their next run, starts the turn, and writes execution logs.

## Job path

Write one JSON file per job at `scheduler/jobs/<uuid>.json`. Use a UUID filename and keep
the same UUID in `id`; the engine rejects mismatches. Use an atomic temp-file-and-rename
write.

## Required shape

```json
{
  "id": "uuid-v4",
  "name": "daily-report",
  "prompt": "Generate the daily report and deliver it to the originating thread.",
  "origin": {
    "source": "telegram",
    "thread_key": "telegram:chat:1706579477",
    "source_thread_ref": {
      "source": "telegram",
      "conversation_id": "1706579477"
    },
    "visibility": "dm"
  },
  "schedule": { "type": "cron", "expression": "0 8 * * *" },
  "run_once": false,
  "status": "active",
  "output": "summary",
  "retry": { "max_attempts": 3, "backoff_ms": 5000 },
  "permissions": ["software-development:repo.write"],
  "created_by": { "source": "telegram", "user_id": "1706579477" },
  "next_run_at": "2026-07-20T08:00:00.000Z",
  "last_run_at": null,
  "created_at": "2026-07-19T10:00:00.000Z"
}
```

`status` is `active`, `paused`, `failed`, or `completed`. `output` is `summary`,
`detail`, or `silent`. Permissions use the `skill:permission` form and are a snapshot
of grants present when the job is created. A one-shot job becomes `completed` only after
a successful run. If a snapshot grant is revoked, the job pauses before execution.

## Schedule rules

Cron uses five fields: minute, hour, day-of-month, month, and day-of-week. Examples:

- `0 8 * * *` — daily at 08:00 UTC.
- `0 */6 * * *` — every six hours.
- `30 9 * * 1-5` — weekdays at 09:30 UTC.

For intervals, set `type` to `interval` and `intervalMs` to a positive integer. Always
calculate `next_run_at` from now. For cron, use the next matching occurrence; never use
a placeholder such as “next hour”. Store times as ISO 8601 UTC strings.

## Mutations

- Create: confirm first, then write a new UUID file.
- List/read: read only; group lists by active, paused, failed, and completed.
- Update: edit schedule/status only and preserve prompt and permissions.
- Delete: confirm first, then remove the job file and execution-log directory.
- Manual run: set `next_run_at` to now for an active job.

The engine writes `scheduler/logs/<job-id>/<execution-id>.json` with attempt, timestamps,
status, exit code, harness log path, output, errors, skipped reasons, and missing
permissions. Different jobs may run concurrently, but occurrences of the same job are
skipped while an execution or retry is still active. Jobs targeting the same originating
thread are serialized to protect session state, and scheduled turns wait for any active
human turn on that thread before using the session.
