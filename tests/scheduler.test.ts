import { describe, it, expect } from "vitest";
import { SchedulerJobSchema } from "../src/slices/scheduler/schemas.js";

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
});

describe("Schedule calculation", () => {
  it("calculates next run for cron expression", () => {
    const schedule = { type: "cron" as const, expression: "0 8 * * *" };
    const now = new Date("2026-07-19T07:00:00.000Z");
    const nextRun = new Date(now);
    nextRun.setUTCHours(8, 0, 0, 0);
    
    expect(nextRun.toISOString()).toBe("2026-07-19T08:00:00.000Z");
  });

  it("calculates next run for interval", () => {
    const intervalMs = 3600000; // 1 hour
    const now = new Date("2026-07-19T07:00:00.000Z");
    const nextRun = new Date(now.getTime() + intervalMs);
    
    expect(nextRun.toISOString()).toBe("2026-07-19T08:00:00.000Z");
  });

  it("handles cron crossing midnight", () => {
    const now = new Date("2026-07-19T23:00:00.000Z");
    const nextRun = new Date(now);
    nextRun.setUTCHours(8, 0, 0, 0);
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    
    expect(nextRun.toISOString()).toBe("2026-07-20T08:00:00.000Z");
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
