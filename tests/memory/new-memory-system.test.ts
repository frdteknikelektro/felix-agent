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

class RollupHarness implements Harness {
  readonly inputs: TurnInput[] = [];
  constructor(private readonly fail = false) {}

  async run(input: TurnInput): Promise<TurnResult> {
    this.inputs.push(input);
    const period = input.promptOverride?.match(/^Period: (.+)$/m)?.[1] ?? "unknown";
    return {
      sessionId: `memory-${this.inputs.length}`,
      exitCode: this.fail ? 1 : 0,
      success: !this.fail,
      parsed: {
        kind: "reply",
        text: this.fail ? "" : `# Memory rollup\n\n- Retained event for ${period}\n`,
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
    await fs.writeFile(cfg.paths.memoryFile, "# Memory\n\n- Must survive maintenance.\n");

    const result = await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(result.monthlyCreated).toContain("2026-06");
    const monthInput = harness.inputs.find((input) => input.promptOverride?.includes("Kind: monthly"));
    expect(monthInput?.promptOverride).toContain("Include only events whose attributed date is within 2026-06");
    expect(monthInput?.promptOverride).toContain("2026-06-01.md");
    expect(monthInput?.promptOverride).toContain("2026-06-29.md");
    await expect(fs.access(path.join(cfg.paths.memoryMonthlyDir, "2025-05.md"))).rejects.toThrow();
    expect(await fs.readFile(cfg.paths.memoryFile, "utf8")).toContain("Must survive");
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
        parsed: { kind: "reply", text: `# Weekly Memory\n\n- attempt ${harness.inputs.length}\n` },
        logPath: "/dev/null",
      };
    };

    await runMemoryMaintenance(cfg, harness, new Date("2026-07-13T00:30:00.000Z"));

    expect(harness.inputs).toHaveLength(2);
    expect(await fs.readFile(path.join(cfg.paths.memoryWeeklyDir, "2026-07-06.md"), "utf8"))
      .toContain("attempt 2");
  });
});
