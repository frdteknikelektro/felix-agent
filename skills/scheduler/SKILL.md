---
name: scheduler
description: Schedule recurring tasks and one-shot reminders from natural-language requests.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: list, read, write
  match: jadwalkan, schedule, periodik, otomatis, alarm, reminder, scheduler, timer
---

# Scheduler

Manage recurring jobs and one-shot alarms by editing scheduler job files. Read
`references/job-schema.md` before creating, updating, or deleting a job.

## Permissions

- `scheduler:list` — list jobs and execution history.
- `scheduler:read` — inspect a job or execution log.
- `scheduler:write` — create, update, pause, resume, or delete jobs.

## Execution

1. Resolve the requester's permissions and identify the current source/thread.
   Completion: the required scheduler permission and original thread key are known.
2. Convert the request into a valid five-field cron expression or positive interval.
   Capture the originating source/thread reference, validate `next_run_at`, prompt
   detail, output mode, timezone, and namespaced permissions.
   Completion: the complete job object is ready and no schedule is guessed.
3. Show the task, resolved schedule, inherited permissions, and output mode. Ask for
   confirmation before creating or deleting; schedule edits also require confirmation.
   Completion: the user explicitly confirmed the requested mutation.
4. Read the reference, then write the UUID-named JSON file atomically under
   `scheduler/jobs/`. Store only permissions currently granted to the creator.
   For updates, preserve fields that are not being changed.
   Completion: the file exists and parses against the documented schema.
5. Re-read the file and report the saved status and next run. For history, read
   `scheduler/logs/<job-id>/`; never claim success without a log record.
   Completion: the response accounts for the mutation or exact failure.

Recurring jobs use `run_once: false`; alarms use `run_once: true`. Keep prompts specific
enough for an independent agent turn. Successful output is delivered to the originating
thread: `ringkas` is concise, `detail` is complete, and `silent` suppresses routine
output. Permission revocation pauses the job and reports the missing grant. If a task
changes, delete and recreate it; edit only the schedule so the authorized work cannot
change silently. Different jobs may run concurrently; the same job never overlaps itself.
