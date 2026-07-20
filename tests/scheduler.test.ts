import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateNextRun } from "../src/slices/scheduler/next-run.js";
import {
  executeJob,
  readJobFile,
  startScheduler,
  stopScheduler,
  tick,
} from "../src/slices/scheduler/index.js";
import type {
  SchedulerExecutionResult,
  SchedulerExecutor,
} from "../src/slices/scheduler/ports.js";
import {
  SchedulerJobSchema,
  type SchedulerJob,
} from "../src/slices/scheduler/schemas.js";
import { writeJsonAtomic } from "../src/lib/fs.js";
import { makeTestConfig } from "./helpers/workspace.js";

afterEach(() => {
  stopScheduler();
});

const ORIGIN = {
  source: "mattermost",
  thread_key: "mattermost:channel:root",
  source_thread_ref: {
    source: "mattermost",
    conversation_id: "channel",
    thread_id: "root",
    root_message_id: "root",
  },
  visibility: "channel" as const,
};

function makeJob(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return SchedulerJobSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-job",
    prompt: "Run the scheduled task.",
    origin: ORIGIN,
    schedule: { type: "cron", expression: "0 8 * * *" },
    run_once: false,
    status: "active",
    output: "ringkas",
    retry: { max_attempts: 3, backoff_ms: 5000 },
    permissions: ["scheduler:read"],
    created_by: { source: "mattermost", user_id: "user-1" },
    next_run_at: "2026-07-20T08:00:00.000Z",
    last_run_at: null,
    created_at: "2026-07-19T10:00:00.000Z",
    ...overrides,
  });
}

async function writeJob(
  cfg: Awaited<ReturnType<typeof makeTestConfig>>,
  job: SchedulerJob,
): Promise<string> {
  const filePath = path.join(cfg.paths.schedulerJobsDir, `${job.id}.json`);
  await writeJsonAtomic(filePath, job);
  return filePath;
}

describe("SchedulerJobSchema", () => {
  it("accepts a complete job with origin and namespaced permissions", () => {
    expect(SchedulerJobSchema.safeParse(makeJob()).success).toBe(true);
  });

  it("rejects invalid IDs, origins, permissions, retries, and active timestamps", () => {
    expect(
      SchedulerJobSchema.safeParse({ ...makeJob(), id: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({ ...makeJob(), origin: undefined }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        origin: {
          ...ORIGIN,
          source_thread_ref: { ...ORIGIN.source_thread_ref, source: "slack" },
        },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        origin: { ...ORIGIN, source_thread_ref: { source: "mattermost" } },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        permissions: ["github.write"],
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        permissions: ["scheduler:"],
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        permissions: [":read"],
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        retry: { max_attempts: 11, backoff_ms: 0 },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        retry: { max_attempts: 1, backoff_ms: 86_400_001 },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({ ...makeJob(), next_run_at: null }).success,
    ).toBe(false);
  });

  it("keeps schedule variants mutually exclusive", () => {
    expect(
      SchedulerJobSchema.safeParse({ ...makeJob(), schedule: { type: "cron" } })
        .success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        schedule: { type: "cron", expression: "0 8 * * *", intervalMs: 60_000 },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...makeJob(),
        schedule: {
          type: "interval",
          expression: "0 8 * * *",
          intervalMs: 60_000,
        },
      }).success,
    ).toBe(false);
  });
});

describe("Schedule calculation", () => {
  it("calculates cron and interval schedules in UTC", () => {
    const now = new Date("2026-07-19T07:00:00.000Z");
    expect(
      calculateNextRun({ type: "cron", expression: "0 8 * * *" }, now),
    ).toBe("2026-07-19T08:00:00.000Z");
    expect(
      calculateNextRun({ type: "interval", intervalMs: 3_600_000 }, now),
    ).toBe("2026-07-19T08:00:00.000Z");
  });

  it("supports cron steps, weekday ranges, and midnight rollover", () => {
    expect(
      calculateNextRun(
        { type: "cron", expression: "0 */6 * * *" },
        new Date("2026-07-19T07:00:00.000Z"),
      ),
    ).toBe("2026-07-19T12:00:00.000Z");
    expect(
      calculateNextRun(
        { type: "cron", expression: "30 9 * * 1-5" },
        new Date("2026-07-19T10:00:00.000Z"),
      ),
    ).toBe("2026-07-20T09:30:00.000Z");
    expect(
      calculateNextRun(
        { type: "cron", expression: "0 8 * * *" },
        new Date("2026-07-19T23:00:00.000Z"),
      ),
    ).toBe("2026-07-20T08:00:00.000Z");
  });

  it("rejects invalid cron expressions instead of falling back", () => {
    expect(() =>
      calculateNextRun(
        { type: "cron", expression: "not a cron expression" },
        new Date("2026-07-19T23:00:00.000Z"),
      ),
    ).toThrow();
  });
});

describe("Scheduler job files", () => {
  it("rejects a file whose basename does not match the UUID in its content", async () => {
    const cfg = await makeTestConfig("scheduler-file-");
    const filePath = path.join(
      cfg.paths.schedulerJobsDir,
      "22222222-2222-4222-8222-222222222222.json",
    );
    await writeJsonAtomic(filePath, makeJob());
    expect(await readJobFile(filePath)).toBeNull();
  });

  it("pauses an active malformed job instead of retrying it forever", async () => {
    const cfg = await makeTestConfig("scheduler-invalid-active-");
    const job = makeJob();
    const filePath = await writeJob(cfg, {
      ...job,
      origin: undefined as never,
    });

    startScheduler(cfg, { run: vi.fn() });
    await tick();

    expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
      "paused",
    );
  });

  it("rejects execution paths that do not match the scheduler job directory", async () => {
    const cfg = await makeTestConfig("scheduler-path-");
    const job = { ...makeJob(), id: "../../outside" } as SchedulerJob;

    await expect(
      executeJob(
        cfg,
        { run: vi.fn() },
        job,
        path.join(cfg.paths.schedulerJobsDir, "outside.json"),
      ),
    ).rejects.toThrow("unsafe scheduler job id");
  });
});

describe("Scheduler execution", () => {
  it("increments attempts for thrown and unsuccessful results", async () => {
    const cfg = await makeTestConfig("scheduler-retry-");
    const job = makeJob({
      id: "33333333-3333-4333-8333-333333333333",
      run_once: true,
      schedule: { type: "interval", intervalMs: 3_600_000 },
      retry: { max_attempts: 3, backoff_ms: 0 },
    });
    const filePath = await writeJob(cfg, job);
    const results: Array<SchedulerExecutionResult | Error> = [
      new Error("thrown failure"),
      { status: "failed", exitCode: 1, error: "unsuccessful" },
      {
        status: "success",
        exitCode: 0,
        logPath: "/tmp/harness.log",
        output: "done",
      },
    ];
    const executor: SchedulerExecutor = {
      run: async () => {
        const result = results.shift()!;
        if (result instanceof Error) throw result;
        return result;
      },
    };

    await executeJob(cfg, executor, job, filePath);

    const executionDir = path.join(cfg.paths.schedulerLogsDir, job.id);
    const executionFiles = await fs.readdir(executionDir);
    expect(executionFiles).toHaveLength(3);
    const executions = await Promise.all(
      executionFiles.map(
        async (file) =>
          JSON.parse(
            await fs.readFile(path.join(executionDir, file), "utf8"),
          ) as { attempt: number; status: string },
      ),
    );
    expect(executions.map((execution) => execution.attempt).sort()).toEqual([
      1, 2, 3,
    ]);
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
      "completed",
    );
  });

  it("pauses a job when the executor reports a missing permission", async () => {
    const cfg = await makeTestConfig("scheduler-paused-");
    const job = makeJob({
      id: "44444444-4444-4444-8444-444444444444",
      permissions: ["scheduler:write"],
    });
    const filePath = await writeJob(cfg, job);
    const executor: SchedulerExecutor = {
      run: async () => ({
        status: "paused",
        missingPermissions: ["scheduler:write"],
      }),
    };

    await executeJob(cfg, executor, job, filePath);

    expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
      "paused",
    );
  });
});

describe("Scheduler concurrency", () => {
  it("runs different origins in parallel and serializes the same origin", async () => {
    vi.useFakeTimers();
    const cfg = await makeTestConfig("scheduler-concurrency-");
    const firstJob = makeJob({
      id: "55555555-5555-4555-8555-555555555555",
      schedule: { type: "interval", intervalMs: 1 },
      next_run_at: "2026-07-19T23:59:59.000Z",
    });
    const secondJob = makeJob({
      id: "66666666-6666-4666-8666-666666666666",
      origin: {
        ...ORIGIN,
        thread_key: "mattermost:channel:second",
        source_thread_ref: {
          ...ORIGIN.source_thread_ref,
          thread_id: "second",
          root_message_id: "second",
        },
      },
      schedule: { type: "interval", intervalMs: 1 },
      next_run_at: "2026-07-19T23:59:59.000Z",
    });
    const sameOriginJob = makeJob({
      id: "77777777-7777-4777-8777-777777777777",
      schedule: { type: "interval", intervalMs: 1 },
      next_run_at: "2026-07-19T23:59:59.000Z",
    });
    await writeJob(cfg, firstJob);
    await writeJob(cfg, secondJob);
    await writeJob(cfg, sameOriginJob);

    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    const executor: SchedulerExecutor = {
      run: async ({ job, signal }) => {
        started.push(job.id);
        return await new Promise<SchedulerExecutionResult>((resolve) => {
          resolvers.set(job.id, () => resolve({ status: "success" }));
          signal.addEventListener(
            "abort",
            () => resolve({ status: "failed", error: "stopped" }),
            { once: true },
          );
        });
      },
    };

    try {
      vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
      startScheduler(cfg, executor);
      await tick();
      await vi.waitFor(() => {
        expect(started).toEqual(
          expect.arrayContaining([firstJob.id, secondJob.id]),
        );
      });
      expect(started).not.toContain(sameOriginJob.id);

      vi.setSystemTime(new Date("2026-07-20T00:00:00.002Z"));
      await tick();
      const firstLogs = await fs.readdir(
        path.join(cfg.paths.schedulerLogsDir, firstJob.id),
      );
      const skipped = await Promise.all(
        firstLogs.map(
          async (file) =>
            JSON.parse(
              await fs.readFile(
                path.join(cfg.paths.schedulerLogsDir, firstJob.id, file),
                "utf8",
              ),
            ) as { status: string },
        ),
      );
      expect(skipped.some((execution) => execution.status === "skipped")).toBe(
        true,
      );

      resolvers.get(firstJob.id)?.();
      await vi.waitFor(() => expect(started).toContain(sameOriginJob.id));
    } finally {
      const startedAtStop = started.length;
      stopScheduler();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(started).toHaveLength(startedAtStop);
      vi.useRealTimers();
    }
  });
});
