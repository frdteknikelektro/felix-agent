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

  it("returns empty threads and no lastLintAt when file does not exist", async () => {
    const cfg = makeConfig(tmp);
    const result = await loadCheckpoint(cfg);
    expect(result.threads).toEqual({});
    expect(result.lastLintAt).toBeUndefined();
  });

  it("saves and loads checkpoint data with threads", async () => {
    const cfg = makeConfig(tmp);
    const data = {
      threads: {
        "mattermost:c1:m1": { lastIngestAt: "2026-06-19T14:00:00Z" },
        "discord:c2:m2": { lastIngestAt: "2026-06-19T15:00:00Z" },
      },
    };
    await saveCheckpoint(cfg, data);
    const result = await loadCheckpoint(cfg);
    expect(result.threads).toEqual(data.threads);
  });

  it("saves and loads lastLintAt", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      threads: {},
      lastLintAt: "2026-06-19T14:00:00Z",
    });
    const result = await loadCheckpoint(cfg);
    expect(result.lastLintAt).toBe("2026-06-19T14:00:00Z");
  });

  it("updates thread entry in checkpoint", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      threads: { "mattermost:c1:m1": { lastIngestAt: "2026-06-19T14:00:00Z" } },
    });

    await saveCheckpoint(cfg, {
      threads: { "mattermost:c1:m1": { lastIngestAt: "2026-06-19T16:00:00Z" } },
    });
    const result = await loadCheckpoint(cfg);
    expect(result.threads["mattermost:c1:m1"].lastIngestAt).toBe("2026-06-19T16:00:00Z");
  });

  it("adds new thread entry to existing checkpoint", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      threads: { "mattermost:c1:m1": { lastIngestAt: "2026-06-19T14:00:00Z" } },
    });

    await saveCheckpoint(cfg, {
      threads: {
        "mattermost:c1:m1": { lastIngestAt: "2026-06-19T14:00:00Z" },
        "discord:c2:m2": { lastIngestAt: "2026-06-19T15:00:00Z" },
      },
    });
    const result = await loadCheckpoint(cfg);
    expect(Object.keys(result.threads)).toHaveLength(2);
    expect(result.threads["discord:c2:m2"]).toBeDefined();
  });

  it("handles legacy checkpoint format gracefully", async () => {
    const cfg = makeConfig(tmp);
    fs.writeFileSync(
      path.join(tmp, "memory", "checkpoint.json"),
      JSON.stringify({
        "mattermost:c1:m1": { lastIngestAt: "2026-06-19T14:00:00Z" },
      }),
    );
    const result = await loadCheckpoint(cfg);
    expect(result.threads).toEqual({});
    expect(result.lastLintAt).toBeUndefined();
  });
});
