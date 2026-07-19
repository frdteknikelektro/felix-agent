---
name: scheduler
description: Schedule recurring tasks and one-shot alarms/reminders via natural language
kind: builtin
permissions:
  - scheduler:list
  - scheduler:read
  - scheduler:write
match:
  - jadwalkan
  - schedule
  - periodik
  - otomatis
  - alarm
  - reminder
  - scheduler
  - timer
---

# Scheduler Skill

This skill manages scheduled tasks and one-shot alarms/reminders for Felix Agent.

## Capabilities

- Create recurring tasks ("jadwalkan")
- Create one-shot alarms/reminders ("alarm")
- List all scheduled jobs
- View job details and execution history
- Pause/resume jobs
- Delete jobs
- Manually trigger jobs

## Natural Language Interface

### Creating Recurring Tasks

Use "jadwalkan" followed by the task description and schedule:

**Examples:**
- "jadwalkan daily report setiap jam 8 pagi"
- "jadwalkan backup database setiap malam jam 2"
- "jadwalkan cek status server setiap 30 menit"

### Creating One-Shot Alarms/Reminders

Use "alarm" followed by the task description and time:

**Examples:**
- "alarm jam 3 sore untuk ingatkan meeting"
- "alarm 15 menit lagi untuk break"

### Listing Jobs

- "lihat semua jadwal"
- "lihat jadwal aktif"
- "lihat jadwal yang pause"

### Managing Jobs

- "hapus jadwal [name/id]"
- "jeda jadwal [name/id]"
- "lanjutkan jadwal [name/id]"
- "ubah jadwal [name/id] ke setiap jam 9 pagi"
- "jalankan jadwal [name/id] sekarang"

## Permission Model

Three permission levels:

1. **scheduler:list** - View all jobs
2. **scheduler:read** - View 1 job detail
3. **scheduler:write** - Create, edit, delete, pause/resume jobs

### Inherited Permissions

Each job stores the creator's permissions at creation time. These permissions are used when the job executes an agent turn, allowing scheduled tasks to access the same resources as the creator.

## Confirmation Flow

Always confirm before creating a job. Show:
1. Task description (full prompt)
2. Schedule (resolved to cron expression + human-readable)
3. Permissions that will be inherited

User can confirm, cancel, or modify before final save.

## Prompt Validation

Before creating a job, validate that the prompt is detailed enough:

**Too vague (ask for clarification):**
- "jadwalkan backup"
- "cek server"

**Detailed enough (proceed):**
- "jadwalkan backup database PostgreSQL ke /backups setiap malam jam 2"
- "cek status server https://api.example.com setiap 30 menit"

## Execution Output

Configurable per-job:
- **ringkas** (default): success/fail status + 1-2 sentence summary
- **detail**: success/fail + full agent output
- **silent**: no delivery (file-only logging)

User specifies during creation: "dengan output detail" atau "silent aja"

## List Format

Grouped by status:
1. Active jobs
2. Paused jobs
3. Failed/completed jobs

Format per job: name, schedule, status, next run

## Edit Flow

Edit only schedule - user can change timing but not the task itself.
If user wants to change the task, they should delete and recreate.

Edit command: "ubah jadwal [job] ke setiap jam 9 pagi"

## Delete Behavior

Always confirm before delete. Show job details:
- Name
- Schedule
- Last run

User confirms with "ya" or cancels. Hard delete (no soft delete for MVP).

## One-Shot Mode

For alarms/reminders:
- "alarm jam 3 sore untuk ingatkan meeting" → `run_once: true`
- "jadwalkan backup setiap malam jam 2" → `run_once: false`

After successful execution, auto-mark as "completed" and don't reschedule.
