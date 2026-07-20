import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, writeJsonAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import { calculateNextRun } from "./next-run.js";
import type {
  SchedulerExecutionRequest,
  SchedulerExecutionResult,
  SchedulerExecutor,
} from "./ports.js";
import { SchedulerJobSchema, type SchedulerJob } from "./schemas.js";

const TICK_INTERVAL_MS = 10_000;
const MAX_RETRY_DELAY_MS = 86_400_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SchedulerState {
  locked: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cfg: AppConfig | null;
  executor: SchedulerExecutor | null;
  inFlightJobs: Set<string>;
  originTails: Map<string, Promise<void>>;
  controllers: Map<string, AbortController>;
  generation: number;
}

interface SchedulerExecution {
  id: string;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: "running" | "success" | "failed" | "paused" | "skipped" | "cancelled";
  attempt: number;
  exit_code?: number;
  log_path?: string;
  output?: string;
  error?: string;
  missing_permissions?: string[];
  skipped_reason?: string;
}

const state: SchedulerState = {
  locked: false,
  running: false,
  timer: null,
  cfg: null,
  executor: null,
  inFlightJobs: new Set(),
  originTails: new Map(),
  controllers: new Map(),
  generation: 0,
};

function jobsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerJobsDir;
}

function logsDir(cfg: AppConfig): string {
  return cfg.paths.schedulerLogsDir;
}

function originKey(job: SchedulerJob): string {
  return `${job.origin.source}\u0000${job.origin.thread_key}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "scheduler stopped")
  );
}

function schedulerJobPath(cfg: AppConfig, jobId: string): string {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`unsafe scheduler job id: ${jobId}`);
  }
  return path.join(jobsDir(cfg), `${jobId}.json`);
}

function assertSchedulerJobPath(
  cfg: AppConfig,
  jobId: string,
  filePath: string,
): void {
  if (path.resolve(filePath) !== path.resolve(schedulerJobPath(cfg, jobId))) {
    throw new Error(
      "scheduler job path is outside the scheduler jobs directory",
    );
  }
}

async function pauseInvalidJobFile(
  filePath: string,
  schedulerDir: string,
): Promise<void> {
  if (path.resolve(path.dirname(filePath)) !== path.resolve(schedulerDir))
    return;
  const expectedId = path.basename(filePath, ".json");
  if (!UUID_PATTERN.test(expectedId)) return;

  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { id?: unknown }).id !== expectedId ||
      (value as { status?: unknown }).status !== "active"
    ) {
      return;
    }
    await writeJsonAtomic(filePath, {
      ...(value as Record<string, unknown>),
      status: "paused",
    });
    log.warn("scheduler: invalid active job paused", {
      file: filePath,
      jobId: expectedId,
    });
  } catch (error) {
    log.warn("scheduler: invalid job could not be paused", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pauseValidJob(
  filePath: string,
  job: SchedulerJob,
  reason: string,
): Promise<void> {
  try {
    await writeJsonAtomic(filePath, { ...job, status: "paused" });
    log.warn("scheduler: active job paused", {
      file: filePath,
      jobId: job.id,
      reason,
    });
  } catch (error) {
    log.warn("scheduler: active job could not be paused", {
      file: filePath,
      jobId: job.id,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readJobFile(
  filePath: string,
): Promise<SchedulerJob | null> {
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

  const expectedId = path.basename(filePath, ".json");
  if (result.data.id !== expectedId) {
    log.warn("scheduler: job filename mismatch", {
      file: filePath,
      jobId: result.data.id,
      expectedId,
    });
    return null;
  }

  return result.data;
}

function scheduleNextTick(): void {
  if (!state.running) return;

  const generation = state.generation;
  const elapsed = Date.now() % TICK_INTERVAL_MS;
  const offset = TICK_INTERVAL_MS - elapsed;
  state.timer = setTimeout(() => {
    state.timer = null;
    void tick()
      .catch((error) => {
        log.error("scheduler: tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (state.running && state.generation === generation) {
          scheduleNextTick();
        }
      });
  }, offset);
  state.timer.unref();
}

export async function tick(): Promise<void> {
  if (!state.running || state.locked || !state.cfg || !state.executor) return;
  state.locked = true;
  const generation = state.generation;

  try {
    const cfg = state.cfg;
    const executor = state.executor;
    const dir = jobsDir(cfg);
    if (!(await pathExists(dir))) return;

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = new Date();

    for (const entry of entries) {
      if (!state.running || state.generation !== generation) break;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const filePath = path.join(dir, entry.name);
      const job = await readJobFile(filePath);
      if (!job) {
        await pauseInvalidJobFile(filePath, dir);
        continue;
      }
      if (job.status !== "active" || !job.next_run_at) continue;

      const nextRun = new Date(job.next_run_at);
      if (Number.isNaN(nextRun.getTime())) {
        log.warn("scheduler: job next_run_at invalid", {
          file: filePath,
          jobId: job.id,
        });
        await pauseValidJob(filePath, job, "invalid_next_run_at");
        continue;
      }
      if (nextRun > now) continue;

      let nextRunAt: string;
      try {
        nextRunAt = calculateNextRun(job.schedule, now);
      } catch (error) {
        log.warn("scheduler: job schedule invalid", {
          file: filePath,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await pauseValidJob(filePath, job, "invalid_schedule");
        continue;
      }

      if (!state.running || state.generation !== generation) break;

      const updated: SchedulerJob = {
        ...job,
        last_run_at: now.toISOString(),
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

      if (state.inFlightJobs.has(job.id)) {
        await writeSkippedExecution(cfg, job, "already_running");
        continue;
      }

      startJob(cfg, executor, updated, filePath);
    }
  } finally {
    state.locked = false;
  }
}

function startJob(
  cfg: AppConfig,
  executor: SchedulerExecutor,
  job: SchedulerJob,
  filePath: string,
): void {
  const controller = new AbortController();
  const key = originKey(job);
  const generation = state.generation;
  const controllerKey = `${job.id}:${generation}:${crypto.randomUUID()}`;
  const previous = state.originTails.get(key) ?? Promise.resolve();

  state.inFlightJobs.add(job.id);
  state.controllers.set(controllerKey, controller);

  const run = previous
    .catch(() => undefined)
    .then(() => {
      if (
        controller.signal.aborted ||
        !state.running ||
        state.generation !== generation
      ) {
        return;
      }
      return executeJob(cfg, executor, job, filePath, controller.signal);
    });
  const tracked = run.finally(() => {
    state.inFlightJobs.delete(job.id);
    state.controllers.delete(controllerKey);
    if (state.originTails.get(key) === tracked) state.originTails.delete(key);
  });
  state.originTails.set(key, tracked);

  void tracked.catch((error) => {
    log.error("scheduler: job execution failed", {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function writeExecution(
  cfg: AppConfig,
  job: SchedulerJob,
  execution: SchedulerExecution,
): Promise<void> {
  if (!UUID_PATTERN.test(job.id)) {
    throw new Error(`unsafe scheduler job id: ${job.id}`);
  }
  const executionDir = path.join(logsDir(cfg), job.id);
  await ensureDir(executionDir);
  await writeJsonAtomic(
    path.join(executionDir, `${execution.id}.json`),
    execution,
  );
}

async function writeSkippedExecution(
  cfg: AppConfig,
  job: SchedulerJob,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await writeExecution(cfg, job, {
    id: crypto.randomUUID(),
    job_id: job.id,
    started_at: now,
    completed_at: now,
    status: "skipped",
    attempt: 0,
    skipped_reason: reason,
  });
  log.info("scheduler: job occurrence skipped", { jobId: job.id, reason });
}

async function updateJobStatus(
  filePath: string,
  status: SchedulerJob["status"],
): Promise<void> {
  const current = await readJobFile(filePath);
  if (!current) return;
  await writeJsonAtomic(filePath, { ...current, status });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("scheduler stopped"));
  const boundedDelay = Math.min(delayMs, MAX_RETRY_DELAY_MS);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, boundedDelay);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("scheduler stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeJob(
  cfg: AppConfig,
  executor: SchedulerExecutor,
  job: SchedulerJob,
  filePath: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  assertSchedulerJobPath(cfg, job.id, filePath);
  for (let attempt = 1; attempt <= job.retry.max_attempts; attempt++) {
    const executionId = crypto.randomUUID();
    const execution: SchedulerExecution = {
      id: executionId,
      job_id: job.id,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: "running",
      attempt,
    };
    await writeExecution(cfg, job, execution);

    let result: SchedulerExecutionResult;
    try {
      result = await executor.run({
        job,
        executionId,
        signal,
      } satisfies SchedulerExecutionRequest);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        execution.status = "cancelled";
        execution.error = "scheduler stopped";
        execution.completed_at = new Date().toISOString();
        await writeExecution(cfg, job, execution);
        return;
      }
      result = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (signal.aborted) {
      execution.status = "cancelled";
      execution.error = "scheduler stopped";
      execution.completed_at = new Date().toISOString();
      await writeExecution(cfg, job, execution);
      return;
    }

    execution.status = result.status;
    execution.completed_at = new Date().toISOString();
    execution.exit_code = result.exitCode;
    execution.log_path = result.logPath;
    execution.output = result.output;
    execution.error = result.error;
    execution.missing_permissions = result.missingPermissions;
    await writeExecution(cfg, job, execution);

    if (result.status === "cancelled") return;

    if (result.status === "success") {
      if (job.run_once) await updateJobStatus(filePath, "completed");
      log.info("scheduler: job executed", {
        jobId: job.id,
        executionId,
        attempt,
      });
      return;
    }

    if (result.status === "paused") {
      await updateJobStatus(filePath, "paused");
      log.warn("scheduler: job paused", {
        jobId: job.id,
        missingPermissions: result.missingPermissions,
      });
      return;
    }

    if (attempt >= job.retry.max_attempts) {
      if (job.run_once) await updateJobStatus(filePath, "failed");
      log.warn("scheduler: job retries exhausted", {
        jobId: job.id,
        executionId,
        attempt,
        maxAttempts: job.retry.max_attempts,
      });
      return;
    }

    const delayMs = job.retry.backoff_ms * Math.pow(2, attempt - 1);
    log.info("scheduler: job retry scheduled", {
      jobId: job.id,
      attempt: attempt + 1,
      backoffMs: Math.min(delayMs, MAX_RETRY_DELAY_MS),
    });
    try {
      await waitForRetry(delayMs, signal);
    } catch (error) {
      execution.status = "cancelled";
      execution.error = error instanceof Error ? error.message : String(error);
      execution.completed_at = new Date().toISOString();
      await writeExecution(cfg, job, execution);
      return;
    }
  }
}

export function startScheduler(
  cfg: AppConfig,
  executor: SchedulerExecutor,
): void {
  if (state.running) return;
  state.generation += 1;
  state.cfg = cfg;
  state.executor = executor;
  state.running = true;
  log.info("scheduler: starting tick loop", { intervalMs: TICK_INTERVAL_MS });
  scheduleNextTick();
}

export function stopScheduler(): void {
  state.generation += 1;
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  for (const controller of state.controllers.values()) controller.abort();
  state.controllers.clear();
  state.cfg = null;
  state.executor = null;
  log.info("scheduler: stopped");
}
