---
name: scheduler
description: Schedule recurring tasks and one-shot reminders with natural language.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: list, read, write
  match: jadwalkan, schedule, periodik, otomatis, alarm, reminder, scheduler, timer
---

# Scheduler

Use the scheduler for recurring work and one-shot alarms. Interpret natural language,
resolve it to a valid cron expression or positive interval, and preserve the original
thread reference when creating a job.

## Permission boundary

- `scheduler:list`: list jobs.
- `scheduler:read`: inspect one job and its execution history.
- `scheduler:write`: create, edit, pause, resume, delete, or manually run a job.

Always resolve the permission boundary before operating. A job inherits the creator's
currently granted permissions; never add permissions during scheduling.

Use the bundled CLI as the single writer for `${WORKSPACE_DIR}/scheduler`:

```bash
SCHEDULER_CLI="${WORKSPACE_DIR}/.agents/skills/scheduler/scheduler.mjs"
node "$SCHEDULER_CLI" list [active|paused|failed|completed]
node "$SCHEDULER_CLI" show "<id>"
node "$SCHEDULER_CLI" run-now "<id>"
```

For `create` and `update`, send JSON on stdin. Resolve natural language first and include
`schedule`, `next_run_at`, `source_thread_key`, and `source_thread_ref`; never guess an
original thread. Use `delete` only after confirmation.

## Conversation rules

Always confirm before creating or deleting. Before confirmation, show the full prompt,
resolved schedule, timezone, output mode, and inherited permissions. Ask for details when
the task is vague (for example, "jadwalkan backup" or "cek server").

Examples:

- `jadwalkan laporan harian setiap jam 8 pagi`
- `jadwalkan cek https://example.test setiap 30 menit`
- `alarm 15 menit lagi untuk meeting`
- `lihat semua jadwal`, `jeda jadwal <id>`, `lanjutkan jadwal <id>`
- `ubah jadwal <id> ke setiap jam 9 pagi`, `jalankan jadwal <id> sekarang`

Recurring jobs use `run_once: false`; alarms use `run_once: true`. One-shot jobs become
`completed` only after a successful execution. Failed jobs retry up to three attempts
with exponential backoff, then become `failed`. Preserve `ringkas`, `detail`, or
`silent` output selection and route non-silent results to the original thread.
