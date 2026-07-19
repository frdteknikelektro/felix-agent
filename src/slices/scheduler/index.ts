import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJsonParsed, writeJsonAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { createOrLoadThread } from "../sessions/index.js";
import { SchedulerJobSchema, type SchedulerJob } from "./schemas.js";

const TICK_INTERVAL_MS = 10_000;
const SCHEDULER_THREAD_KEY = "scheduler-system";

interface SchedulerState {
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cfg: AppConfig | null;
  harness: Harness | null;
}

const state: SchedulerState = { locked: false, timer: null, cfg: null, harness: null };

// ─── Path helpers ─────────────────────────────────────────────────────────────

function jobsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerJobsDir;
}

function logsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerLogsDir;
}

// ─── Tick loop ────────────────────────────────────────────────────────────────

function scheduleNextTick(): void {
  const now = Date.now();
  const elapsed = now % TICK_INTERVAL_MS;
  const offset = TICK_INTERVAL_MS - elapsed;

  state.timer = setTimeout(() => {
    state.timer = null;
    tick()
      .catch((err) => {
        log.error("scheduler: tick failed", { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        scheduleNextTick();
      });
  }, offset);

  state.timer.unref();
}

async function tick(): Promise<void> {
  if (state.locked || !state.cfg || !state.harness) return;
  state.locked = true;

  try {
    const cfg = state.cfg;
    const harness = state.harness;
    const dir = jobsDir(cfg);

    if (!(await pathExists(dir))) return;

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = new Date();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const filePath = path.join(dir, entry.name);
      const job = await readJsonParsed(filePath, SchedulerJobSchema, null);
      if (!job || job.status !== "active" || !job.next_run_at) continue;

      const nextRun = new Date(job.next_run_at);
      if (nextRun > now) continue;

      // Atomic update: set next_run_at before execution to prevent race condition
      const nextRunAt = calculateNextRun(job.schedule);
      const updated: SchedulerJob = {
        ...job,
        last_run_at: new Date().toISOString(),
        next_run_at: nextRunAt,
      };
      await writeJsonAtomic(filePath, updated);

      // Execute job in parallel (fire and forget)
      executeJob(cfg, harness, job).catch((err) => {
        log.error("scheduler: job execution failed", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } finally {
    state.locked = false;
  }
}

// ─── Schedule calculation ─────────────────────────────────────────────────────

function calculateNextRun(schedule: SchedulerJob["schedule"]): string {
  const now = new Date();

  if (schedule.type === "interval" && schedule.intervalMs) {
    return new Date(now.getTime() + schedule.intervalMs).toISOString();
  }

  if (schedule.type === "cron" && schedule.expression) {
    // Simple cron parsing - return next matching time
    // For MVP: handle basic "HH MM * * *" patterns
    const parts = schedule.expression.split(" ");
    if (parts.length >= 2) {
      const [minute, hour] = parts;
      if (hour !== "*" && minute !== "*") {
        const next = new Date(now);
        next.setUTCHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);
        if (next <= now) {
          next.setUTCDate(next.getUTCDate() + 1);
        }
        return next.toISOString();
      }
    }
  }

  // Default: next hour
  const next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return next.toISOString();
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function schedulerThread(cfg: AppConfig): Promise<ThreadHandle> {
  return createOrLoadThread(cfg, {
    source: "system",
    thread_key: SCHEDULER_THREAD_KEY,
    source_thread_ref: null as never,
    received_at: new Date().toISOString(),
  });
}

async function executeJob(cfg: AppConfig, harness: Harness, job: SchedulerJob): Promise<void> {
  const executionId = crypto.randomUUID();
  const executionDir = path.join(logsDir(cfg), job.id);
  await ensureDir(executionDir);

  const execution: {
    id: string;
    job_id: string;
    started_at: string;
    completed_at: string | null;
    status: "running" | "success" | "failed";
    attempt: number;
  } = {
    id: executionId,
    job_id: job.id,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    attempt: 1,
  };

  const executionPath = path.join(executionDir, `${executionId}.json`);
  await writeJsonAtomic(executionPath, execution);

  try {
    const thread = await schedulerThread(cfg);
    const input: TurnInput = {
      thread,
      event: {
        source: "system",
        thread_key: SCHEDULER_THREAD_KEY,
        event_id: `scheduler-${executionId}`,
        received_at: new Date().toISOString(),
        visibility: "channel" as const,
        mentions_bot: false,
        sender: { source: "system", id: "scheduler" },
        text: job.prompt,
        attachments: [],
        raw_path: "",
        source_thread_ref: null as never,
      },
      eventFile: "",
      contact: {
        user_id: job.created_by.user_id,
        source: job.created_by.source,
        display: "Scheduler",
        allowed_permissions: job.permissions,
      },
      skills: [],
      sourceContext: { behaviorInstructions: [] },
      resumed: false,
    };

    const result = await harness.run(input);

    execution.completed_at = new Date().toISOString();
    execution.status = result.success ? "success" : "failed";
    await writeJsonAtomic(executionPath, execution);

    // Auto-mark one-shot jobs as completed
    if (job.run_once && result.success) {
      const completedJob = { ...job, status: "completed" as const };
      await writeJsonAtomic(path.join(jobsDir(cfg), `${job.id}.json`), completedJob);
    }

    log.info("scheduler: job executed", { jobId: job.id, executionId, status: execution.status });
  } catch (err) {
    execution.completed_at = new Date().toISOString();
    execution.status = "failed";
    await writeJsonAtomic(executionPath, execution);

    // Retry logic
    if (execution.attempt < job.retry.max_attempts) {
      const backoffMs = job.retry.backoff_ms * Math.pow(2, execution.attempt - 1);
      setTimeout(() => {
        executeJob(cfg, harness, { ...job, retry: { ...job.retry, max_attempts: job.retry.max_attempts - execution.attempt } }).catch(() => {});
      }, backoffMs);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startScheduler(cfg: AppConfig, harness: Harness): void {
  if (state.timer) return;

  state.cfg = cfg;
  state.harness = harness;

  log.info("scheduler: starting tick loop", { intervalMs: TICK_INTERVAL_MS });
  scheduleNextTick();
}

export function stopScheduler(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
    log.info("scheduler: stopped");
  }
}
