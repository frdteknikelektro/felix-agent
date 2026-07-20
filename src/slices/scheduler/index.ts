import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJsonParsed, writeJsonAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { SourceAdapter } from "../../core/ports.js";
import type { SourceThreadRef, UniversalEvent } from "../../types.js";
import { appendFelixReply, createOrLoadThread, type ThreadHandle } from "../sessions/index.js";
import { memoryCycleSlot, runMemoryCycle } from "../memory/index.js";
import {
  SchedulerJobSchema,
  SchedulerExecutionSchema,
  type SchedulerJob,
  type SchedulerExecution,
  type Schedule,
} from "./schemas.js";

const TICK_INTERVAL_MS = 10_000;
export interface SchedulerAdapterResolver {
  (source: string): SourceAdapter;
}

interface SchedulerState {
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cfg: AppConfig | null;
  harness: Harness | null;
  resolveAdapter: SchedulerAdapterResolver | null;
  memorySlot: string | null;
}

const state: SchedulerState = {
  locked: false,
  timer: null,
  cfg: null,
  harness: null,
  resolveAdapter: null,
  memorySlot: null,
};

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

export async function createJob(
  cfg: AppConfig,
  job: Omit<SchedulerJob, "id" | "created_at" | "updated_at" | "next_run_at" | "status" | "last_run_at" | "retry">,
): Promise<SchedulerJob> {
  validateSchedule(job.schedule);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fullJob: SchedulerJob = {
    ...job,
    id,
    status: "active",
    next_run_at: calculateNextRun(job.schedule),
    last_run_at: null,
    retry: { max_attempts: 3, backoff_ms: 5_000 },
    created_at: now,
    updated_at: now,
  };

  await ensureDir(jobsDir(cfg));
  await writeJsonAtomic(jobFilePath(cfg, id), fullJob);
  log.info("scheduler: job created", { id, name: job.name });
  return fullJob;
}

export async function readJob(cfg: AppConfig, jobId: string): Promise<SchedulerJob | null> {
  if (!(await pathExists(jobFilePath(cfg, jobId)))) return null;
  return readJsonParsed(jobFilePath(cfg, jobId), SchedulerJobSchema, null);
}

export async function updateJob(
  cfg: AppConfig,
  jobId: string,
  updates: Partial<Pick<SchedulerJob, "schedule" | "status">>,
): Promise<SchedulerJob | null> {
  const job = await readJob(cfg, jobId);
  if (!job) return null;
  if (updates.schedule) validateSchedule(updates.schedule);

  const status = updates.status ?? job.status;
  const scheduleChanged = updates.schedule !== undefined;
  const resumed = status === "active" && job.status !== "active";
  const updated: SchedulerJob = {
    ...job,
    ...updates,
    next_run_at: scheduleChanged || resumed ? calculateNextRun(updates.schedule ?? job.schedule) : job.next_run_at,
    updated_at: new Date().toISOString(),
  };
  if (status !== "active") updated.next_run_at = null;

  await writeJsonAtomic(jobFilePath(cfg, jobId), updated);
  log.info("scheduler: job updated", { id: jobId, status: updated.status });
  return updated;
}

export async function deleteJob(cfg: AppConfig, jobId: string): Promise<boolean> {
  const file = jobFilePath(cfg, jobId);
  if (!(await pathExists(file))) return false;
  await fs.unlink(file);
  await fs.rm(path.join(logsDir(cfg), jobId), { recursive: true, force: true });
  log.info("scheduler: job deleted", { id: jobId });
  return true;
}

export async function listJobs(
  cfg: AppConfig,
  filter?: { status?: SchedulerJob["status"] },
): Promise<SchedulerJob[]> {
  await ensureDir(jobsDir(cfg));
  const entries = await fs.readdir(jobsDir(cfg), { withFileTypes: true });
  const jobs: SchedulerJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const job = await readJsonParsed(path.join(jobsDir(cfg), entry.name), SchedulerJobSchema, null);
    if (job && (!filter?.status || job.status === filter.status)) jobs.push(job);
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

export function calculateNextRun(schedule: Schedule, after = new Date()): string {
  validateSchedule(schedule);
  if (schedule.type === "interval") {
    return new Date(after.getTime() + schedule.intervalMs!).toISOString();
  }
  if (schedule.type === "natural") {
    if (schedule.expression) return nextCronRun(schedule.expression, schedule.timezone, after).toISOString();
    return new Date(after.getTime() + schedule.intervalMs!).toISOString();
  }
  return nextCronRun(schedule.expression!, schedule.timezone, after).toISOString();
}

function validateSchedule(schedule: Schedule): void {
  if (schedule.type === "interval" && !schedule.intervalMs) {
    throw new Error("interval schedules require a positive intervalMs");
  }
  if ((schedule.type === "cron" || schedule.type === "natural") && !schedule.expression && !schedule.intervalMs) {
    throw new Error("schedule must contain a resolved cron expression or intervalMs");
  }
  if (schedule.expression) parseCron(schedule.expression);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone ?? "UTC" }).format();
  } catch {
    throw new Error(`invalid IANA timezone: ${schedule.timezone}`);
  }
}

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

function parseCron(expression: string): [CronField, CronField, CronField, CronField, CronField] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must have exactly five fields");
  return [
    parseCronField(fields[0], 0, 59),
    parseCronField(fields[1], 0, 23),
    parseCronField(fields[2], 1, 31),
    parseCronField(fields[3], 1, 12),
    parseCronField(fields[4], 0, 7, true),
  ];
}

function parseCronField(raw: string, min: number, max: number, sundayAlias = false): CronField {
  const values = new Set<number>();
  const wildcard = raw === "*" || raw.startsWith("*/");
  for (const token of raw.split(",")) {
    const [rangePart, stepText] = token.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${token}`);
    const [startText, endText] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`invalid cron field: ${token}`);
    }
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  return { values, wildcard };
}

function nextCronRun(expression: string, timezone = "UTC", after = new Date()): Date {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parseCron(expression);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const maxMinutes = 366 * 24 * 60 * 2;
  for (let offset = 0; offset <= maxMinutes; offset++) {
    const candidate = new Date(start + offset * 60_000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const localMinute = Number(parts.minute);
    const localHour = Number(parts.hour);
    const localDay = Number(parts.day);
    const localMonth = Number(parts.month);
    const localWeekday = new Date(Date.UTC(Number(parts.year), localMonth - 1, localDay)).getUTCDay();
    const dayMatches = dayOfMonth.values.has(localDay);
    const weekMatches = dayOfWeek.values.has(localWeekday);
    const calendarDayMatches = dayOfMonth.wildcard && dayOfWeek.wildcard
      ? true
      : dayOfMonth.wildcard
        ? weekMatches
        : dayOfWeek.wildcard
          ? dayMatches
          : dayMatches || weekMatches;
    if (minute.values.has(localMinute) && hour.values.has(localHour) && month.values.has(localMonth) && calendarDayMatches) {
      return candidate;
    }
  }
  throw new Error(`cron expression has no occurrence within two years: ${expression}`);
}

async function claimJob(cfg: AppConfig, job: SchedulerJob, now: Date): Promise<SchedulerJob> {
  const claimed: SchedulerJob = {
    ...job,
    last_run_at: now.toISOString(),
    next_run_at: job.run_once ? null : calculateNextRun(job.schedule, now),
    updated_at: now.toISOString(),
  };
  await writeJsonAtomic(jobFilePath(cfg, job.id), claimed);
  return claimed;
}

function eventForJob(job: SchedulerJob, executionId: string): UniversalEvent {
  return {
    source: job.source_thread_ref.source,
    thread_key: job.source_thread_key,
    event_id: `scheduler-${executionId}`,
    received_at: new Date().toISOString(),
    visibility: "channel",
    mentions_bot: false,
    sender: { source: job.created_by.source, id: job.created_by.user_id },
    text: job.prompt,
    attachments: [],
    raw_path: "",
    source_thread_ref: job.source_thread_ref,
  };
}

async function jobThread(cfg: AppConfig, job: SchedulerJob): Promise<ThreadHandle> {
  return createOrLoadThread(cfg, {
    source: "system",
    thread_key: `scheduler:${job.id}`,
    source_thread_ref: job.source_thread_ref,
    received_at: new Date().toISOString(),
  });
}

function buildTurnInput(thread: ThreadHandle, event: UniversalEvent, job: SchedulerJob): TurnInput {
  return {
    thread,
    event,
    eventFile: "",
    contact: {
      user_id: job.created_by.user_id,
      source: job.created_by.source,
      display: job.created_by.user_id,
      allowed_permissions: job.permissions,
    },
    skills: [],
    sourceContext: { behaviorInstructions: [] },
    resumed: false,
  };
}

async function executeJob(cfg: AppConfig, harness: Harness, job: SchedulerJob, resolveAdapter: SchedulerAdapterResolver | null): Promise<void> {
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
    await ensureDir(path.join(logsDir(cfg), job.id));
    await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);

    let result: Awaited<ReturnType<Harness["run"]>> | null = null;
    let error: string | undefined;
    try {
      const thread = await jobThread(cfg, job);
      const event = eventForJob(job, executionId);
      result = await harness.run(buildTurnInput(thread, event, job));
      if (result.success && job.output !== "silent" && resolveAdapter && result.parsed.text) {
        const adapter = resolveAdapter(job.source_thread_ref.source);
        await adapter.sendThreadReply({ event, text: result.parsed.text });
        await appendFelixReply(thread, new Date().toISOString(), result.parsed.text, result.sessionId);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    execution.completed_at = new Date().toISOString();
    execution.status = result?.success ? "success" : "failed";
    execution.session_id = result?.sessionId;
    execution.result = result?.success
      ? { success: true, output: result.parsed.text }
      : { success: false, error: error ?? `Exit code: ${result?.exitCode ?? -1}` };

    if (execution.status === "success") {
      await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);
      if (job.run_once) await updateJob(cfg, job.id, { status: "completed" });
      log.info("scheduler: job executed", { jobId: job.id, executionId, attempt });
      return;
    }

    if (attempt < job.retry.max_attempts) {
      execution.status = "retrying";
      await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);
      await delay(job.retry.backoff_ms * 2 ** (attempt - 1));
      continue;
    }

    await writeJsonAtomic(executionFilePath(cfg, job.id, executionId), execution);
    if (job.run_once) await updateJob(cfg, job.id, { status: "failed" });
    log.warn("scheduler: job failed", { jobId: job.id, executionId, attempt });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function tick(): Promise<void> {
  if (state.locked || !state.cfg || !state.harness) return;
  state.locked = true;
  try {
    const now = new Date();
    const jobs = await listJobs(state.cfg, { status: "active" });
    for (const job of jobs) {
      if (!job.next_run_at || new Date(job.next_run_at) > now) continue;
      const claimed = await claimJob(state.cfg, job, now);
      void executeJob(state.cfg, state.harness, claimed, state.resolveAdapter).catch((error) => {
        log.error("scheduler: job execution failed", { jobId: job.id, error: String(error) });
      });
    }

    const slot = memoryCycleSlot(now);
    if (slot !== state.memorySlot) {
      state.memorySlot = slot;
      void runMemoryCycle(state.cfg, state.harness).catch((error) => {
        log.error("memory: cycle failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  } finally {
    state.locked = false;
  }
}

function scheduleNextTick(): void {
  const delayMs = TICK_INTERVAL_MS - (Date.now() % TICK_INTERVAL_MS);
  const timer = setTimeout(() => {
    state.timer = null;
    void tick().finally(scheduleNextTick);
  }, delayMs);
  timer.unref();
  state.timer = timer;
}

export function startScheduler(cfg: AppConfig, harness: Harness, resolveAdapter?: SchedulerAdapterResolver): void {
  if (state.timer) return;
  state.cfg = cfg;
  state.harness = harness;
  state.resolveAdapter = resolveAdapter ?? null;
  state.memorySlot = memoryCycleSlot(new Date());
  log.info("scheduler: starting tick loop", { intervalMs: TICK_INTERVAL_MS });
  scheduleNextTick();
}

export function stopScheduler(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.cfg = null;
  state.harness = null;
  state.resolveAdapter = null;
  state.memorySlot = null;
  state.locked = false;
  log.info("scheduler: stopped");
}

export async function runJobNow(cfg: AppConfig, harness: Harness, jobId: string, resolveAdapter?: SchedulerAdapterResolver): Promise<boolean> {
  const job = await readJob(cfg, jobId);
  if (!job || job.status !== "active") return false;
  const claimed = await claimJob(cfg, job, new Date());
  await executeJob(cfg, harness, claimed, resolveAdapter ?? null);
  return true;
}

export async function getJobExecutions(cfg: AppConfig, jobId: string): Promise<SchedulerExecution[]> {
  const dir = path.join(logsDir(cfg), jobId);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const executions: SchedulerExecution[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const execution = await readJsonParsed(path.join(dir, entry.name), SchedulerExecutionSchema, null);
    if (execution) executions.push(execution);
  }
  return executions.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
}

export type { Schedule, SchedulerJob, SchedulerExecution } from "./schemas.js";
export type { SourceThreadRef };
