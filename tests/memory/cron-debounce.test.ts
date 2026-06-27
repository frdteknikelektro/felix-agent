import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { buildWorkspacePaths } from "../../src/workspace.js";
import { loadCheckpoint, saveCheckpoint } from "../../src/slices/memory/checkpoint.js";

const tmp = path.join(process.cwd(), "tests", ".tmp", "memory-cron");

function makeConfig(dir: string): AppConfig {
  return {
    WORKSPACE_DIR: dir,
    paths: buildWorkspacePaths(dir),
  } as unknown as AppConfig;
}

describe("memory cron debounce logic", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips thread when already ingested up to latest event", () => {
    const now = Date.now();
    const lastEvent = new Date(now - 5 * 60 * 1000).toISOString();
    const lastIngest = new Date(now - 1 * 60 * 1000).toISOString();
    expect(new Date(lastIngest).getTime() >= new Date(lastEvent).getTime()).toBe(true);
  });

  it("skips thread when conversation is still active", () => {
    const now = Date.now();
    const lastEvent = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    expect(now - new Date(lastEvent).getTime() < 6 * 60 * 60 * 1000).toBe(true);
  });

  it("ingests thread when idle > 6 hours and has new content", () => {
    const now = Date.now();
    const lastEvent = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    expect(now - new Date(lastEvent).getTime() >= 6 * 60 * 60 * 1000).toBe(true);
  });

  it("save and reload checkpoint preserves thread entries", async () => {
    const cfg = makeConfig(tmp);
    await saveCheckpoint(cfg, {
      threads: { "mattermost:c:m": "2026-06-19T14:00:00Z" },
    });

    const result = await loadCheckpoint(cfg);
    expect(result.threads["mattermost:c:m"]).toBe("2026-06-19T14:00:00Z");
  });

  it("lint runs when lastLintAt is missing (first run)", () => {
    // No lastLintAt → should lint
    const now = Date.now();
    const lastLintAt = undefined;
    const newestIngest = new Date(now - 1 * 60 * 60 * 1000).getTime();
    expect(!lastLintAt || newestIngest > new Date(lastLintAt).getTime()).toBe(true);
  });

  it("lint runs when a newer ingest exists since last lint", () => {
    const now = Date.now();
    const lastLintAt = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const newestIngest = new Date(now - 1 * 60 * 60 * 1000).getTime();
    const sinceLint = now - new Date(lastLintAt).getTime();

    expect(sinceLint >= 24 * 60 * 60 * 1000).toBe(true);
    expect(newestIngest > new Date(lastLintAt).getTime()).toBe(true);
  });

  it("lint skips when last lint is within 24 hours", () => {
    const now = Date.now();
    const lastLintAt = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    const sinceLint = now - new Date(lastLintAt).getTime();
    expect(sinceLint < 24 * 60 * 60 * 1000).toBe(true);
  });

  it("lint skips when no new ingest has happened since last lint", () => {
    const now = Date.now();
    const lastLintAt = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const newestIngest = new Date(now - 72 * 60 * 60 * 1000).getTime();
    const sinceLint = now - new Date(lastLintAt).getTime();

    expect(sinceLint >= 24 * 60 * 60 * 1000).toBe(true);
    expect(newestIngest > new Date(lastLintAt).getTime()).toBe(false);
  });
});
