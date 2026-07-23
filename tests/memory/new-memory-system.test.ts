import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness, TurnInput, TurnResult } from "../../src/core/ports.js";
import {
  nextMemoryMaintenanceAt,
  runMemoryMaintenance,
} from "../../src/slices/memory/index.js";
import { ensureWorkspace } from "../../src/workspace.js";
import { makeTestConfig } from "../helpers/workspace.js";

const roots: string[] = [];

function weekStart(key: string): string {
  const date = new Date(`${key}T12:00:00.000Z`);
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - isoDay + 1);
  return date.toISOString().slice(0, 10);
}

class RollupHarness implements Harness {
  readonly inputs: TurnInput[] = [];
  constructor(private readonly fail = false) {}

  async run(input: TurnInput): Promise<TurnResult> {
    this.inputs.push(input);
    const period = input.promptOverride?.match(/^Period: (.+)$/m)?.[1] ?? "unknown";
    const sourceDates = [...(input.promptOverride ?? "").matchAll(/-\s+.*?(\d{4}-\d{2}-\d{2})\.md/g)]
      .map((match) => match[1]!);
    const date = sourceDates.find((value) => /^\d{4}-\d{2}$/.test(period) ? value.startsWith(`${period}-`) : weekStart(value) === period);
    return {
      sessionId: `memory-${this.inputs.length}`,
      exitCode: this.fail ? 1 : 0,
      success: !this.fail,
      parsed: {
        kind: "reply",
        text: this.fail ? "" : !date
          ? "# Memory rollup\n\n_No events retained._\n"
          : `# Memory rollup\n\n- ${date}: Retained event\n`,
      },
      logPath: "/dev/null",
    };
  }
}

async function setup(extras = {}) {
  const cfg = await makeTestConfig("felix-memory-", {
    OWNER_TZ: "Asia/Jakarta",
    USAGE_TZ: "Asia/Jakarta",
    MEMORY_MAINTENANCE_CRON: "0 3 * * *",
    CODEX_MODEL_FOR_MEMORIZING: "gpt-low-cost",
    ...extras,
  });
  roots.push(path.dirname(cfg.WORKSPACE_DIR));
  await ensureWorkspace(cfg.paths);
  return cfg;
}

async function put(dir: string, name: string, text = `- ${name} event\n`) {
  await fs.writeFile(path.join(dir, `${name}.md`), text);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Memory maintenance", () => {
  it("rolls completed owner-local weeks up before deleting covered daily Memory", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    await put(cfg.paths.memoryDailyDir, "2026-07-05");
    await put(cfg.paths.memoryDailyDir, "2026-07-06");
    await put(cfg.paths.memoryDailyDir, "2026-07-07");

    const result = await runMemoryMaintenance(
      cfg,
      harness,
      new Date("2026-07-13T00:30:00.000Z"), // 07:30 Monday in OWNER_TZ
    );

    expect(result.weeklyCreated).toContain("2026-07-06");
    expect(await fs.readFile(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"), "utf8"))
      .toContain("Retained event");
    const weekInput = harness.inputs.find((input) => input.promptOverride?.includes("Period: 2026-07-06"));
    expect(weekInput?.modelOverride).toBe("gpt-low-cost");
    expect(weekInput?.promptOverride).toContain("2026-07-06.md");
    expect(weekInput?.promptOverride).toContain("2026-07-07.md");
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-07-05.md"))).rejects.toThrow();
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-07-06.md"))).rejects.toThrow();
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-07-07.md"))).resolves.toBeUndefined();
  });

  it("publishes explicit empty rollups atomically and treats the file as coverage", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    harness.run = async (input) => {
      harness.inputs.push(input);
      return {
        sessionId: "empty",
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: "# Weekly Memory\n\n_No events retained._\n" },
        logPath: "/dev/null",
      };
    };

    const now = new Date("2026-07-13T00:30:00.000Z");
    await runMemoryMaintenance(cfg, harness, now);
    await runMemoryMaintenance(cfg, harness, now);

    expect(await fs.readFile(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"), "utf8"))
      .toBe("# Weekly Memory\n\n_No events retained._\n");
    expect(harness.inputs).toHaveLength(1);
  });

  it("refreshes existing coverage when a source changes", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    const source = path.join(cfg.paths.memoryDailyDir, "2026-07-12.md");
    await fs.writeFile(source, "- initial event\n");
    const now = new Date("2026-07-13T00:30:00.000Z");
    await runMemoryMaintenance(cfg, harness, now);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await fs.appendFile(source, "- late event\n");

    await runMemoryMaintenance(cfg, harness, now);

    expect(harness.inputs).toHaveLength(3);
  });

  it("does not publish coverage or clean sources when the low-cost model fails", async () => {
    const cfg = await setup();
    const harness = new RollupHarness(true);
    await put(cfg.paths.memoryDailyDir, "2026-07-01");
    await put(cfg.paths.memoryDailyDir, "2026-06-20");
    await put(cfg.paths.memoryWeeklyDir, "2026-06-15");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures.length).toBeGreaterThan(0);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-06-29.md"))).rejects.toThrow();
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-07-01.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-06-20.md"))).resolves.toBeUndefined();
    expect(harness.inputs.length).toBeGreaterThan(0);
    expect(harness.inputs.every((input) => input.modelOverride === "gpt-low-cost")).toBe(true);
  });

  it("builds a completed month from intersecting weeks and retains only twelve completed months", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    for (const week of ["2026-05-25", "2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"]) {
      await put(cfg.paths.memoryWeeklyDir, week);
    }
    await put(cfg.paths.memoryMonthlyDir, "2025-05");
    await put(cfg.paths.memoryMonthlyDir, "2025-07");
    await fs.writeFile(cfg.paths.memoryFile, "# Memory\n\n- Must survive maintenance.\n");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.monthlyCreated).toContain("2026-06");
    const monthInput = harness.inputs.find((input) => input.promptOverride?.includes("Kind: monthly"));
    expect(monthInput?.promptOverride).toContain("Include only events whose attributed date is within 2026-06");
    expect(monthInput?.promptOverride).toContain("2026-06-01.md");
    expect(monthInput?.promptOverride).toContain("2026-06-29.md");
    await expect(fs.access(path.join(cfg.paths.memoryMonthlyDir, "2025-05.md"))).rejects.toThrow();
    await expect(fs.access(path.join(cfg.paths.memoryMonthlyDir, "2025-07.md"))).resolves.toBeUndefined();
    expect(await fs.readFile(cfg.paths.memoryFile, "utf8")).toContain("Must survive");
  });

  it("reports unreadable weekly sources and blocks monthly cleanup", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    for (const week of ["2026-05-25", "2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"]) {
      await put(cfg.paths.memoryWeeklyDir, week);
    }
    const unsafe = path.join(cfg.paths.memoryWeeklyDir, "2026-06-15.md");
    await fs.rm(unsafe);
    await fs.mkdir(unsafe);
    await put(cfg.paths.memoryMonthlyDir, "2025-07");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures.some((failure) => failure.includes("2026-06-15.md"))).toBe(true);
    expect((await fs.lstat(unsafe)).isDirectory()).toBe(true);
    await expect(fs.access(path.join(cfg.paths.memoryMonthlyDir, "2025-07.md"))).resolves.toBeUndefined();
  });

  it("rejects non-empty rollups whose dates are not grounded in their sources", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    harness.run = async (input) => {
      harness.inputs.push(input);
      return {
        sessionId: "invalid-date",
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: "# Weekly Memory\n\n- 2026-07-20: invented\n" },
        logPath: "/dev/null",
      };
    };
    await put(cfg.paths.memoryDailyDir, "2026-07-06");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures.some((failure) => failure.includes("not grounded"))).toBe(true);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"))).rejects.toThrow();
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-07-06.md"))).resolves.toBeUndefined();
  });

  it("accepts arbitrary readable Markdown", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    harness.run = async (input) => {
      harness.inputs.push(input);
      return {
        sessionId: `format-${harness.inputs.length}`,
        exitCode: 0,
        success: true,
        parsed: {
          kind: "reply",
          text: "# Weekly Memory\n\n- Discussed the launch.\n",
        },
        logPath: "/dev/null",
      };
    };
    await put(cfg.paths.memoryDailyDir, "2026-07-06");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures).toEqual([]);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"))).resolves.toBeUndefined();
    expect(harness.inputs).toHaveLength(2);
  });

  it("does not trust an empty marker when mixed with invented content", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    harness.run = async (input) => {
      harness.inputs.push(input);
      return {
        sessionId: "mixed-empty",
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: "# Weekly Memory\n\n_No events retained._\n\n- 2099-01-01: invented\n" },
        logPath: "/dev/null",
      };
    };
    await put(cfg.paths.memoryDailyDir, "2026-07-06");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures.some((failure) => failure.includes("not grounded"))).toBe(true);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"))).rejects.toThrow();
  });

  it("preserves unreadable inputs and blocks dependent cleanup", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    const unsafe = path.join(cfg.paths.memoryDailyDir, "2026-07-01.md");
    await fs.mkdir(unsafe);

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures.some((failure) => failure.includes("2026-07-01.md"))).toBe(true);
    expect((await fs.lstat(unsafe)).isDirectory()).toBe(true);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-06-29.md"))).rejects.toThrow();
  });

  it("ignores malformed period filenames without aborting maintenance", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    await put(cfg.paths.memoryDailyDir, "2026-99-99");
    await put(cfg.paths.memoryWeeklyDir, "2026-13-40");
    await put(cfg.paths.memoryMonthlyDir, "2026-42");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.weeklyCreated).toEqual(["2026-07-06"]);
    await expect(fs.access(path.join(cfg.paths.memoryDailyDir, "2026-99-99.md"))).resolves.toBeUndefined();
  });

  it("catches up every completed week from the oldest retained daily record", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    await put(cfg.paths.memoryDailyDir, "2026-06-01");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.weeklyCreated).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
      "2026-07-06",
    ]);
  });

  it("backfills leading empty weeks needed by the first partial month", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    await put(cfg.paths.memoryDailyDir, "2026-06-17");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.weeklyCreated).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
      "2026-07-06",
    ]);
    expect(result.monthlyCreated).toContain("2026-06");
  });

  it("does not treat an unreadable period directory as an empty period", async () => {
    const cfg = await setup();
    const harness = new RollupHarness();
    await fs.rm(cfg.paths.memoryDailyDir, { recursive: true });
    await fs.writeFile(cfg.paths.memoryDailyDir, "not a directory");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.failures).toHaveLength(1);
    expect(harness.inputs).toHaveLength(0);
    await expect(fs.access(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"))).rejects.toThrow();
  });

  it("schedules 03:00 in OWNER_TZ across daylight-saving transitions", async () => {
    const cfg = await setup({
      OWNER_TZ: "America/New_York",
      USAGE_TZ: "America/New_York",
    });

    expect(nextMemoryMaintenanceAt(cfg, new Date("2026-03-07T12:00:00.000Z")).toISOString())
      .toBe("2026-03-08T07:00:00.000Z");
    expect(nextMemoryMaintenanceAt(cfg, new Date("2026-03-08T08:00:00.000Z")).toISOString())
      .toBe("2026-03-09T07:00:00.000Z");
  });

  it("retries a rollup when a source changes before atomic publication", async () => {
    const cfg = await setup();
    const source = path.join(cfg.paths.memoryDailyDir, "2026-07-06.md");
    await fs.writeFile(source, "- original\n");
    const harness = new RollupHarness();
    harness.run = async (input) => {
      harness.inputs.push(input);
      if (harness.inputs.length === 1) await fs.appendFile(source, "- concurrent update\n");
      return {
        sessionId: `retry-${harness.inputs.length}`,
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: `# Weekly Memory\n\n- 2026-07-06: attempt ${harness.inputs.length}\n` },
        logPath: "/dev/null",
      };
    };

    await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(harness.inputs).toHaveLength(2);
    expect(await fs.readFile(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"), "utf8"))
      .toContain("attempt 2");
  });
});
