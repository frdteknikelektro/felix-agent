import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../src/core/harness-common.js";
import { tzDateKey, weekStartKey, monthStartKey, dateKeyRange } from "../src/lib/time.js";
import { aggregateRecords, deltaCumulative, resolveContactId } from "../src/slices/usage/index.js";
// @ts-expect-error — report.mjs is an untyped ESM skill script, imported to assert parity.
import { aggregate as reportAggregate } from "../skills/usage-report/report.mjs";
import type { UsageRecord } from "../src/types.js";
import type { TurnUsage } from "../src/core/ports.js";

describe("normalizeUsage", () => {
  it("returns null when no tokens are present", () => {
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ input: 0, output: 0 })).toBeNull();
  });

  it("coerces string counts and excludes cache_read from total", () => {
    const u = normalizeUsage({ input: "100", output: 50, cache_read: 10, cache_write: 5, model: "m1" });
    expect(u).toEqual({ input: 100, output: 50, cache_read: 10, cache_write: 5, total: 155, model: "m1" });
  });

  it("ignores negative/NaN and defaults model to null", () => {
    const u = normalizeUsage({ input: -5, output: "oops", cache_write: 7 });
    expect(u).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 7, total: 7, model: null });
  });
});

describe("timezone calendar keys", () => {
  it("rolls the date forward for a positive-offset zone", () => {
    // 20:00 UTC is already the next calendar day in Jakarta (UTC+7).
    expect(tzDateKey("2026-06-26T20:00:00.000Z", "Asia/Jakarta")).toBe("2026-06-27");
    expect(tzDateKey("2026-06-26T20:00:00.000Z", "UTC")).toBe("2026-06-26");
  });

  it("computes ISO week start (Monday) and month start", () => {
    const fri = new Date("2026-06-26T12:00:00.000Z");
    expect(weekStartKey(fri, "UTC")).toBe("2026-06-22"); // Monday
    expect(monthStartKey(fri, "UTC")).toBe("2026-06-01");
  });

  it("enumerates an inclusive date range", () => {
    expect(dateKeyRange("2026-06-22", "2026-06-24")).toEqual(["2026-06-22", "2026-06-23", "2026-06-24"]);
  });
});

describe("aggregateRecords", () => {
  const now = new Date("2026-06-26T12:00:00.000Z"); // Friday
  const tz = "UTC";

  function rec(over: Partial<UsageRecord>): UsageRecord {
    return {
      schema_version: 1,
      at: "2026-06-26T08:00:00.000Z",
      source: "mattermost",
      contact_id: "c1",
      thread_key: "t1",
      harness: "codex",
      model: "m1",
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
      ...over,
    };
  }

  const records: UsageRecord[] = [
    rec({ at: "2026-06-26T08:00:00.000Z", contact_id: "c1", source: "mattermost", model: "m1", thread_key: "t1", input: 100, output: 50, cache_read: 10, cache_write: 5, total: 155 }),
    rec({ at: "2026-06-24T08:00:00.000Z", contact_id: "c2", source: "discord", model: "m2", thread_key: "t2", input: 150, output: 50, total: 200 }),
    rec({ at: "2026-06-10T08:00:00.000Z", contact_id: "c1", source: "slack", model: "m1", thread_key: "t3", total: 300 }),
    rec({ at: "2026-05-30T08:00:00.000Z", contact_id: "c3", source: "slack", model: "m2", thread_key: "t4", total: 999 }),
  ];

  it("filters to today", () => {
    const v = aggregateRecords(records, "today", tz, now);
    expect(v.totals.turns).toBe(1);
    expect(v.totals.total).toBe(155);
  });

  it("filters to the calendar week (Mon–now)", () => {
    const v = aggregateRecords(records, "week", tz, now);
    expect(v.totals.turns).toBe(2); // 06-26 + 06-24
    expect(v.totals.total).toBe(355);
  });

  it("filters to month-to-date", () => {
    const v = aggregateRecords(records, "month", tz, now);
    expect(v.totals.turns).toBe(3); // June records
    expect(v.totals.total).toBe(655);
  });

  it("includes everything for all-time", () => {
    const v = aggregateRecords(records, "all", tz, now);
    expect(v.totals.turns).toBe(4);
    expect(v.totals.total).toBe(1654);
  });

  it("groups breakdowns and sorts by total desc", () => {
    const v = aggregateRecords(records, "all", tz, now);
    expect(v.byContact.map((r) => r.key)).toEqual(["c3", "c1", "c2"]);
    const c1 = v.byContact.find((r) => r.key === "c1")!;
    expect(c1.total).toBe(455); // 155 + 300
    expect(c1.turns).toBe(2);
    expect(v.bySource.map((r) => r.key)).toContain("slack");
    expect(v.byModel.find((r) => r.key === "m1")!.total).toBe(455);
  });

  it("respects timezone when bucketing — a late-UTC turn counts as next day", () => {
    const lateNight = [rec({ at: "2026-06-26T20:00:00.000Z", total: 42 })];
    // In Jakarta that instant is 2026-06-27, so it is NOT part of 2026-06-26.
    const jktNow = new Date("2026-06-26T15:00:00.000Z"); // 2026-06-26 22:00 Jakarta
    const v = aggregateRecords(lateNight, "today", "Asia/Jakarta", jktNow);
    expect(v.totals.turns).toBe(0);
  });

  it("matches the usage-report skill's aggregation (parity)", () => {
    for (const window of ["today", "week", "month", "all"] as const) {
      const server = aggregateRecords(records, window, "UTC", now);
      const skill = reportAggregate(records, window, now); // report.mjs defaults to UTC
      expect(skill.totals.total).toBe(server.totals.total);
      expect(skill.byContact.map((r: [string, number]) => r[0])).toEqual(
        server.byContact.map((r) => r.key),
      );
    }
  });
});

describe("deltaCumulative (codex per-turn from cumulative)", () => {
  const u = (total: number, input = total, output = 0): TurnUsage => ({
    input,
    output,
    cache_read: 0,
    cache_write: 0,
    total,
    model: "gpt",
  });

  it("returns the full value on the first turn (no stored cumulative)", () => {
    expect(deltaCumulative(u(100), null).total).toBe(100);
  });

  it("subtracts the stored cumulative on subsequent turns", () => {
    expect(deltaCumulative(u(250), { input: 100, output: 0, cache_read: 0, cache_write: 0, total: 100 }).total).toBe(150);
  });

  it("treats a smaller current value as a reset and records it in full", () => {
    // Session was cleared → fresh cumulative is small; record it as-is, not negative.
    expect(deltaCumulative(u(40), { input: 100, output: 0, cache_read: 0, cache_write: 0, total: 100 }).total).toBe(40);
  });

  it("a 3-turn cumulative sequence sums to the final cumulative", () => {
    let stored: { input: number; output: number; cache_read: number; cache_write: number; total: number } | null = null;
    let sum = 0;
    for (const c of [u(100), u(300), u(450)]) {
      sum += deltaCumulative(c, stored).total;
      stored = { input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write, total: c.total };
    }
    expect(sum).toBe(450);
  });
});

describe("resolveContactId (system-turn attribution)", () => {
  it("uses the real sender for human turns", () => {
    expect(resolveContactId({ source: "mattermost", id: "u1" }, undefined)).toBe("mattermost:u1");
  });

  it("attributes system turns to the last human sender", () => {
    expect(resolveContactId({ source: "mattermost", id: "system" }, "mattermost:u1")).toBe("mattermost:u1");
  });

  it("falls back to 'system' when no human sender is known", () => {
    expect(resolveContactId({ source: "mattermost", id: "system" }, undefined)).toBe("system");
  });
});
