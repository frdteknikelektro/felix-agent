import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJsonParsed, writeJsonAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { createOrLoadThread } from "../sessions/index.js";
import {
  SchedulerJobSchema,
  SchedulerExecutionSchema,
  type SchedulerJob,
  type SchedulerExecution,
} from "./schemas.js";

const TICK_INTERVAL_MS = 10_000; // 10 seconds
const MEMORY_SYSTEM_THREAD_KEY = "scheduler-system";

interface SchedulerState {
  locked: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const state: SchedulerState = { locked: false, timer: null };

// ─── Path helpers ─────────────────────────────────────────────────────────────

function jobsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerJobsDir;
}

function logsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerLogsDir;
}

function jobFilePath(cfg: AppConfig, jobId: string): string {
  return path.join(jobsDir(cfg), `${jobId}.json`);
}

function executionFilePath(cfg: AppConfig, jobId: string, executionId: string): string {
  return path.join(logsDir(cfg), jobId, `${executionId}.json`);
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

export async function createJob(
  cfg: AppConfig,
  job: Omit<SchedulerJob, "id" | "created_at" | "updated_at" | "next_run_at" | "status" | "last_run_at" | "retry">
): Promise<SchedulerJob> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const nextRunAt = calculateNextRun(job.schedule);

  const fullJob: SchedulerJob = {
    ...job,
    id,
    status: "active",
    next_run_at: nextRunAt,
    last_run_at: null,
    retry: { max_attempts: 3, backoff_ms: 5000 },
    created_at: now,
    updated_at: now,
  };

  await ensureDir(jobsDir(cfg));
  await writeJsonAtomic(jobFilePath(cfg, id), fullJob);
  log.info("scheduler: job created", { id, name: job.name });
  return fullJob;
}

export async function readJob(cfg: AppConfig, jobId: string): Promise<SchedulerJob | null> {
  const file = jobFilePath(cfg, jobId);
  if (!(await pathExists(file))) return null;
  const job = await readJsonParsed(file, SchedulerJobSchema, null as unknown as SchedulerJob);
  return job ?? null;
}

export async function updateJob(
  cfg: AppConfig,
  jobId: string,
  updates: Partial<Pick<SchedulerJob, "schedule" | "status" | "prompt" | "output" | "name">>
): Promise<SchedulerJob | null> {
  const job = await readJob(cfg, jobId);
  if (!job) return null;

  const updated: SchedulerJob = {
    ...job,
    ...updates,
    next_run_at: updates.schedule ? calculateNextRun(updates.schedule) : job.next_run_at,
    updated_at: new Date().toISOString(),
  };

  await writeJsonAtomic(jobFilePath(cfg, jobId), updated);
  log.info("scheduler: job updated", { id: jobId });
  return updated;
}

export async function deleteJob(cfg: AppConfig, jobId: string): Promise<boolean> {
  const file = jobFilePath(cfg, jobId);
  if (!(await pathExists(file))) return false;
  await fs.unlink(file);
  log.info("scheduler: job deleted", { id: jobId });
  return true;
}

export async function listJobs(
  cfg: AppConfig,
  filter?: { status?: SchedulerJob["status"] }
): Promise<SchedulerJob[]> {
  await ensureDir(jobsDir(cfg));
  const entries = await fs.readdir(jobsDir(cfg), { withFileTypes: true });
  const jobs: SchedulerJob[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(jobsDir(cfg), entry.name);
    const job = await readJsonParsed(file, SchedulerJobSchema, null as unknown as SchedulerJob);
    if (job && (!filter?.status || job.status === filter.status)) {
      jobs.push(job as SchedulerJob);
    }
  }

  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Schedule calculation ─────────────────────────────────────────────────────

function calculateNextRun(schedule: SchedulerJob["schedule"]): string {
  const now = new Date();

  if (schedule.type === "interval" && schedule.intervalMs) {
    return new Date(now.getTime() + schedule.intervalMs).toISOString();
  }

  if (schedule.type === "cron" && schedule.expression) {
    // Simple cron parsing for MVP - just return next hour for now
    // TODO: Use cron-parser library for proper parsing
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return next.toISOString();
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
    thread_key: MEMORY_SYSTEM_THREAD_KEY,
    source_thread_ref: null as never,
    received_at: new Date().toISOString(),
  });
}

async function executeJob(cfg: AppConfig, harness: Harness, job: SchedulerJob): Promise<void> {
  const executionId = crypto.randomUUID();
  const execution: SchedulerExecution = {
    id: executionId,
    job_id: job.id,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    attempt: 1,
  };

  await ensureDir(path.join(logsDir(cfg), job.id));
  await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);

  try {
    const thread = await schedulerThread(cfg);
    const input: TurnInput = {
      thread,
      event: {
        source: "system",
        thread_key: MEMORY_SYSTEM_THREAD_KEY,
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
    execution.result = {
      success: result.success,
      output: result.success ? "Job completed successfully" : undefined,
      error: result.success ? undefined : `Exit code: ${result.exitCode}`,
    };
    execution.session_id = result.sessionId;

    if (job.run_once && result.success) {
      await updateJob(cfg, job.id, { status: "completed" });
    }
  } catch (err) {
    execution.completed_at = new Date().toISOString();
    execution.status = "failed";
    execution.result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };

    // Retry logic
    if (execution.attempt < job.retry.max_attempts) {
      execution.status = "retrying";
      await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);
      
      const backoffMs = job.retry.backoff_ms * Math.pow(2, execution.attempt - 1);
      setTimeout(() => {
        const retryExecution: SchedulerExecution = {
          ...execution,
          id: crypto.randomUUID(),
          started_at: new Date().toISOString(),
          completed_at: null,
          status: "running",
          attempt: execution.attempt + 1,
        };
        executeJobWithRetry(cfg, harness, job, retryExecution);
      }, backoffMs);
      return;
    }
  }

  await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);
  log.info("scheduler: job executed", { jobId: job.id, executionId, status: execution.status });
}

async function executeJobWithRetry(
  cfg: AppConfig,
  harness: Harness,
  job: SchedulerJob,
  execution: SchedulerExecution
): Promise<void> {
  await writeJsonAtomic(executionFilePath(cfg, job.id, execution.id), execution);

  try {
    const thread = await schedulerThread(cfg);
    const input: TurnInput = {
      thread,
      event: {
        source: "system",
        thread_key: MEMORY_SYSTEM_THREAD_KEY,
        event_id: `scheduler-${execution.id}`,
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
    execution.result = {
      success: result.success,
      output: result.success ? "Job completed successfully" : undefined,
      error: result.success ? undefined : `Exit code: ${result.exitCode}`,
    };
    execution.session_id = result.sessionId;

    if (job.run_once && result.success) {
      await updateJob(cfg, job.id, { status: "completed" });
    }
  } catch (err) {
    execution.completed_at = new Date().toISOString();
    execution.status = "failed";
    execution.result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await writeJsonAtomic(executionFilePath(cfg, job.id, execution.id), execution);
  log.info("scheduler: job executed (retry)", {
    jobId: job.id,
    executionId: execution.id,
    attempt: execution.attempt,
    status: execution.status,
  });
}

// ─── Tick loop ────────────────────────────────────────────────────────────────

async function tick(cfg: AppConfig, harness: Harness): Promise<void> {
  if (state.locked) return;
  state.locked = true;

  try {
    const jobs = await listJobs(cfg, { status: "active" });
    const now = new Date();

    for (const job of jobs) {
      if (!job.next_run_at) continue;
      const nextRun = new Date(job.next_run_at);
      if (nextRun > now) continue;

      // Atomic update: immediately update next_run_at before execution
      const updatedJob = await updateJob(cfg, job.id, {
        schedule: job.schedule,
      });

      if (updatedJob) {
        // Execute job in parallel
        executeJob(cfg, harness, updatedJob).catch((err) => {
          log.error("scheduler: job execution failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  } finally {
    state.locked = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startScheduler(cfg: AppConfig, harness: Harness): void {
  if (state.timer) return;

  log.info("scheduler: starting tick loop", { intervalMs: TICK_INTERVAL_MS });
  state.timer = setInterval(() => {
    tick(cfg, harness).catch((err) => {
      log.error("scheduler: tick failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, TICK_INTERVAL_MS);

  // Unref so it doesn't block process exit
  state.timer.unref();
}

export function stopScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    log.info("scheduler: stopped");
  }
}

export async function getJobExecutions(
  cfg: AppConfig,
  jobId: string
): Promise<SchedulerExecution[]> {
  const jobLogsDir = path.join(logsDir(cfg), jobId);
  if (!(await pathExists(jobLogsDir))) return [];

  const entries = await fs.readdir(jobLogsDir, { withFileTypes: true });
  const executions: SchedulerExecution[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(jobLogsDir, entry.name);
    const execution = await readJsonParsed(
      file,
      SchedulerExecutionSchema,
      null as unknown as SchedulerExecution
    );
    if (execution) executions.push(execution as SchedulerExecution);
  }

  return executions.sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
}
