import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, writeJsonAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { createOrLoadThread } from "../sessions/index.js";
import { calculateNextRun } from "./next-run.js";
import { SchedulerJobSchema, type SchedulerJob } from "./schemas.js";

const TICK_INTERVAL_MS = 10_000;
const SCHEDULER_THREAD_KEY = "scheduler-system";

interface SchedulerState {
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cfg: AppConfig | null;
  harness: Harness | null;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
}

const state: SchedulerState = {
  locked: false,
  timer: null,
  cfg: null,
  harness: null,
  retryTimers: new Set(),
};

// ─── Path helpers ─────────────────────────────────────────────────────────────

function jobsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerJobsDir;
}

function logsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerLogsDir;
}

async function readJobFile(filePath: string): Promise<SchedulerJob | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    log.warn("scheduler: job read failed", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    log.warn("scheduler: job JSON invalid", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const result = SchedulerJobSchema.safeParse(value);
  if (!result.success) {
    log.warn("scheduler: job schema invalid", {
      file: filePath,
      issues: result.error.issues,
    });
    return null;
  }

  return result.data;
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
        log.error("scheduler: tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
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
      const job = await readJobFile(filePath);
      if (!job || job.status !== "active" || !job.next_run_at) continue;

      const nextRun = new Date(job.next_run_at);
      if (Number.isNaN(nextRun.getTime())) {
        log.warn("scheduler: job next_run_at invalid", {
          file: filePath,
          jobId: job.id,
        });
        continue;
      }
      if (nextRun > now) continue;

      // Atomic update: set next_run_at before execution to prevent race condition
      let nextRunAt: string;
      try {
        nextRunAt = calculateNextRun(job.schedule, now);
      } catch (error) {
        log.warn("scheduler: job schedule invalid", {
          file: filePath,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const updated: SchedulerJob = {
        ...job,
        last_run_at: new Date().toISOString(),
        next_run_at: nextRunAt,
      };
      try {
        await writeJsonAtomic(filePath, updated);
      } catch (error) {
        log.error("scheduler: job advance failed", {
          file: filePath,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Execute job in parallel (fire and forget)
      executeJob(cfg, harness, updated).catch((err) => {
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

// ─── Execution ────────────────────────────────────────────────────────────────

async function schedulerThread(cfg: AppConfig): Promise<ThreadHandle> {
  return createOrLoadThread(cfg, {
    source: "system",
    thread_key: SCHEDULER_THREAD_KEY,
    source_thread_ref: null as never,
    received_at: new Date().toISOString(),
  });
}

interface SchedulerExecution {
  id: string;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: "running" | "success" | "failed";
  attempt: number;
}

function scheduleRetry(
  cfg: AppConfig,
  harness: Harness,
  job: SchedulerJob,
  attempt: number,
  backoffMs: number,
): void {
  const timer = setTimeout(() => {
    state.retryTimers.delete(timer);
    executeJob(cfg, harness, job, attempt + 1).catch((error) => {
      log.error("scheduler: retry execution failed", {
        jobId: job.id,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, backoffMs);
  timer.unref();
  state.retryTimers.add(timer);
}

export async function executeJob(
  cfg: AppConfig,
  harness: Harness,
  job: SchedulerJob,
  attempt = 1,
): Promise<void> {
  const executionId = crypto.randomUUID();
  const executionDir = path.join(logsDir(cfg), job.id);
  await ensureDir(executionDir);

  const execution: SchedulerExecution = {
    id: executionId,
    job_id: job.id,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    attempt,
  };

  const executionPath = path.join(executionDir, `${executionId}.json`);
  await writeJsonAtomic(executionPath, execution);

  let succeeded = false;
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
      promptOverride: job.prompt,
      modelOverride: job.model,
    };

    const result = await harness.run(input);
    succeeded = result.success;
  } catch (err) {
    execution.status = "failed";
    log.warn("scheduler: job attempt failed", {
      jobId: job.id,
      executionId,
      attempt,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  execution.completed_at = new Date().toISOString();
  execution.status = succeeded ? "success" : "failed";
  await writeJsonAtomic(executionPath, execution);

  if (succeeded) {
    // Auto-mark one-shot jobs as completed
    if (job.run_once) {
      const completedJob = { ...job, status: "completed" as const };
      await writeJsonAtomic(
        path.join(jobsDir(cfg), `${job.id}.json`),
        completedJob,
      );
    }

    log.info("scheduler: job executed", {
      jobId: job.id,
      executionId,
      attempt,
      status: execution.status,
    });
    return;
  }

  if (attempt >= job.retry.max_attempts) {
    if (job.run_once) {
      const failedJob = { ...job, status: "failed" as const };
      await writeJsonAtomic(
        path.join(jobsDir(cfg), `${job.id}.json`),
        failedJob,
      );
    }
    log.warn("scheduler: job retries exhausted", {
      jobId: job.id,
      executionId,
      attempt,
      maxAttempts: job.retry.max_attempts,
    });
    return;
  }

  const backoffMs = job.retry.backoff_ms * Math.pow(2, attempt - 1);
  log.info("scheduler: job retry scheduled", {
    jobId: job.id,
    attempt: attempt + 1,
    backoffMs,
  });
  scheduleRetry(cfg, harness, job, attempt, backoffMs);
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
  }
  for (const timer of state.retryTimers) clearTimeout(timer);
  state.retryTimers.clear();
  state.cfg = null;
  state.harness = null;
  log.info("scheduler: stopped");
}
