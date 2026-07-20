import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  calculateNextRun,
  createJob,
  deleteJob,
  listJobs,
  readJob,
  updateJob,
} from "../src/slices/scheduler/index.js";
import { buildWorkspacePaths, ensureWorkspace } from "../src/workspace.js";

const cleanups: string[] = [];

function makeConfig(root: string): AppConfig {
  return { WORKSPACE_DIR: root, paths: buildWorkspacePaths(root) } as AppConfig;
}

function jobInput() {
  return {
    name: "hourly report",
    prompt: "Generate the hourly report and send it to the original thread.",
    schedule: { type: "interval" as const, intervalMs: 60 * 60 * 1000, timezone: "UTC" },
    run_once: false,
    created_by: { source: "mattermost", user_id: "user-1" },
    source_thread_ref: { source: "mattermost", conversation_id: "channel-1", root_message_id: "post-1" },
    source_thread_key: "mattermost:channel-1:post-1",
    permissions: ["reports:read"],
    output: "ringkas" as const,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("scheduler", () => {
  it("calculates interval and timezone-aware cron occurrences", () => {
    const after = new Date("2026-07-20T07:30:00.000Z");
    expect(calculateNextRun({ type: "interval", intervalMs: 30 * 60 * 1000 }, after)).toBe("2026-07-20T08:00:00.000Z");
    expect(calculateNextRun({ type: "cron", expression: "0 8 * * *", timezone: "America/New_York" }, after)).toBe("2026-07-20T12:00:00.000Z");
  });

  it("rejects unresolved schedules instead of silently inventing a time", () => {
    expect(() => calculateNextRun({ type: "natural", naturalLanguage: "every morning" })).toThrow(/resolved cron expression or intervalMs/);
    expect(() => calculateNextRun({ type: "cron", expression: "not cron" })).toThrow(/exactly five fields/);
  });

  it("persists, filters, pauses, resumes, and deletes jobs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-scheduler-"));
    cleanups.push(root);
    const cfg = makeConfig(root);
    await ensureWorkspace(cfg.paths);

    const created = await createJob(cfg, jobInput());
    expect(created.status).toBe("active");
    expect(created.next_run_at).toBeTruthy();
    expect((await readJob(cfg, created.id))?.source_thread_key).toBe("mattermost:channel-1:post-1");
    expect((await listJobs(cfg, { status: "active" }))).toHaveLength(1);

    const paused = await updateJob(cfg, created.id, { status: "paused" });
    expect(paused?.next_run_at).toBeNull();
    expect((await listJobs(cfg, { status: "active" }))).toHaveLength(0);

    const resumed = await updateJob(cfg, created.id, { status: "active" });
    expect(resumed?.next_run_at).toBeTruthy();
    expect(await deleteJob(cfg, created.id)).toBe(true);
    expect(await readJob(cfg, created.id)).toBeNull();
  });
});
