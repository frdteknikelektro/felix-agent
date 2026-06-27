import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCheckpoint, saveCheckpoint } from "../../src/slices/memory/checkpoint.js";
import type { AppConfig } from "../../src/config.js";
import { buildWorkspacePaths } from "../../src/workspace.js";

const tmp = path.join(process.cwd(), "tests", ".tmp", "memory-checkpoint");

function makeConfig(dir: string): AppConfig {
  return {
    WORKSPACE_DIR: dir,
    paths: buildWorkspacePaths(dir),
  } as unknown as AppConfig;
}

describe("memory checkpoint", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns undefined timestamps when file does not exist", async () => {
    const cfg = makeConfig(tmp);
    const result = await loadCheckpoint(cfg);
    expect(result.lastIngestedAt).toBeUndefined();
    expect(result.lastLintAt).toBeUndefined();
  });

  it("saves and loads lastIngestedAt", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      lastIngestedAt: "2026-06-19T14:00:00Z",
    });
    const result = await loadCheckpoint(cfg);
    expect(result.lastIngestedAt).toBe("2026-06-19T14:00:00Z");
  });

  it("saves and loads lastLintAt", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      lastLintAt: "2026-06-19T14:00:00Z",
    });
    const result = await loadCheckpoint(cfg);
    expect(result.lastLintAt).toBe("2026-06-19T14:00:00Z");
  });

  it("saves and loads both timestamps", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      lastIngestedAt: "2026-06-19T14:00:00Z",
      lastLintAt: "2026-06-19T15:00:00Z",
    });
    const result = await loadCheckpoint(cfg);
    expect(result.lastIngestedAt).toBe("2026-06-19T14:00:00Z");
    expect(result.lastLintAt).toBe("2026-06-19T15:00:00Z");
  });

  it("handles empty checkpoint file", async () => {
    const cfg = makeConfig(tmp);
    fs.writeFileSync(
      path.join(tmp, "memory", "checkpoint.json"),
      JSON.stringify({}),
    );
    const result = await loadCheckpoint(cfg);
    expect(result.lastIngestedAt).toBeUndefined();
    expect(result.lastLintAt).toBeUndefined();
  });
});
