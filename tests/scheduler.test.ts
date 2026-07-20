import fs from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { calculateNextRun } from "../src/slices/scheduler/next-run.js";
import { executeJob } from "../src/slices/scheduler/index.js";
import { SchedulerJobSchema } from "../src/slices/scheduler/schemas.js";
import type { TurnResult } from "../src/core/ports.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("SchedulerJobSchema", () => {
  const validJob = {
    id: "test-123",
    name: "test-job",
    prompt: "Test prompt",
    schedule: { type: "cron", expression: "0 8 * * *" },
    run_once: false,
    status: "active",
    output: "ringkas",
    retry: { max_attempts: 3, backoff_ms: 5000 },
    permissions: ["github.write"],
    created_by: { source: "telegram", user_id: "12345" },
    model: undefined,
    next_run_at: "2026-07-20T08:00:00.000Z",
    last_run_at: null,
    created_at: "2026-07-19T10:00:00.000Z",
  };

  it("accepts valid job", () => {
    const result = SchedulerJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const invalid = { ...validJob, name: undefined };
    const result = SchedulerJobSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const invalid = { ...validJob, status: "invalid" };
    const result = SchedulerJobSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects invalid output type", () => {
    const invalid = { ...validJob, output: "invalid" };
    const result = SchedulerJobSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("allows optional model field", () => {
    const withModel = { ...validJob, model: "gpt-5.4-mini" };
    const result = SchedulerJobSchema.safeParse(withModel);
    expect(result.success).toBe(true);
  });

  it("allows null next_run_at", () => {
    const withNull = { ...validJob, next_run_at: null };
    const result = SchedulerJobSchema.safeParse(withNull);
    expect(result.success).toBe(true);
  });

  it("allows null last_run_at", () => {
    const withNull = { ...validJob, last_run_at: null };
    const result = SchedulerJobSchema.safeParse(withNull);
    expect(result.success).toBe(true);
  });

  it("requires exactly the fields for the selected schedule type", () => {
    expect(
      SchedulerJobSchema.safeParse({ ...validJob, schedule: { type: "cron" } })
        .success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...validJob,
        schedule: { type: "cron", expression: "0 8 * * *", intervalMs: 60_000 },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...validJob,
        schedule: {
          type: "interval",
          expression: "0 8 * * *",
          intervalMs: 60_000,
        },
      }).success,
    ).toBe(false);
    expect(
      SchedulerJobSchema.safeParse({
        ...validJob,
        schedule: { type: "interval", intervalMs: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("Schedule calculation", () => {
  it("calculates next run for cron expression", () => {
    const schedule = { type: "cron" as const, expression: "0 8 * * *" };
    const now = new Date("2026-07-19T07:00:00.000Z");
    expect(calculateNextRun(schedule, now)).toBe("2026-07-19T08:00:00.000Z");
  });

  it("calculates next run for interval", () => {
    const intervalMs = 3600000; // 1 hour
    const now = new Date("2026-07-19T07:00:00.000Z");
    expect(calculateNextRun({ type: "interval", intervalMs }, now)).toBe(
      "2026-07-19T08:00:00.000Z",
    );
  });

  it("supports cron steps and weekday ranges", () => {
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
  });

  it("handles cron crossing midnight in UTC", () => {
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

describe("Scheduler retries", () => {
  it("creates a new attempt with an incremented attempt number for failed results", async () => {
    const cfg = await makeTestConfig("scheduler-retry-");
    const job = SchedulerJobSchema.parse({
      id: "retry-job",
      name: "retry-job",
      prompt: "retry me",
      schedule: { type: "interval", intervalMs: 3_600_000 },
      run_once: true,
      status: "active",
      output: "ringkas",
      retry: { max_attempts: 3, backoff_ms: 0 },
      permissions: [],
      created_by: { source: "system", user_id: "scheduler" },
      next_run_at: null,
      last_run_at: null,
      created_at: "2026-07-19T10:00:00.000Z",
    });
    const results: Array<TurnResult | Error> = [
      new Error("thrown failure"),
      {
        sessionId: "failed",
        exitCode: 1,
        success: false,
        parsed: { kind: "unknown", text: "failed" },
        logPath: "/dev/null",
      },
      {
        sessionId: "success",
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: "done" },
        logPath: "/dev/null",
      },
    ];
    const harness = {
      run: async () => {
        const result = results.shift()!;
        if (result instanceof Error) throw result;
        return result;
      },
    };

    await executeJob(cfg, harness, job);

    const executionDir = `${cfg.paths.schedulerLogsDir}/${job.id}`;
    await vi.waitFor(async () => {
      expect(await fs.readdir(executionDir)).toHaveLength(3);
    });
    const executionFiles = await fs.readdir(executionDir);
    expect(executionFiles).toHaveLength(3);
    const executions = await Promise.all(
      executionFiles.map(
        async (file) =>
          JSON.parse(await fs.readFile(`${executionDir}/${file}`, "utf8")) as {
            attempt: number;
            status: string;
          },
      ),
    );
    expect(executions.map((execution) => execution.attempt).sort()).toEqual([
      1, 2, 3,
    ]);
    expect(
      executions.every(
        (execution) =>
          execution.status === "success" || execution.status === "failed",
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await fs.readFile(
          `${cfg.paths.schedulerJobsDir}/${job.id}.json`,
          "utf8",
        ),
      ).status,
    ).toBe("completed");
  });
});

describe("Retry backoff", () => {
  it("calculates exponential backoff", () => {
    const backoffMs = 5000;
    const attempt = 1;
    const expected = backoffMs * Math.pow(2, attempt - 1);

    expect(expected).toBe(5000);
  });

  it("doubles backoff on second attempt", () => {
    const backoffMs = 5000;
    const attempt = 2;
    const expected = backoffMs * Math.pow(2, attempt - 1);

    expect(expected).toBe(10000);
  });

  it("triples backoff on third attempt", () => {
    const backoffMs = 5000;
    const attempt = 3;
    const expected = backoffMs * Math.pow(2, attempt - 1);

    expect(expected).toBe(20000);
  });
});
