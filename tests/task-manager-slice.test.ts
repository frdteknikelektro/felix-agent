import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspacePaths, ensureWorkspace } from "../src/workspace.js";
import {
  createTask,
  generateTaskId,
  listTasks,
  moveTask,
  readTask,
  resolveTaskPath,
} from "../src/slices/tasks/index.js";
import type { AppConfig } from "../src/config.js";
import type { TaskRecord } from "../src/types.js";

async function makeTestCfg(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-tasks-"));
  const workspace = path.join(root, "workspace");
  return {
    WORKSPACE_DIR: workspace,
    SECRET_ENV_FILE: "/run/secrets/.env",
    CODEX_BIN: "codex",
    CODEX_MODEL: "gpt-5.4-mini",
    CODEX_BYPASS_SANDBOX: true,
    CODEX_REASONING_EFFORT: "high",
    CODEX_TIMEOUT_SECONDS: 1800,
    HARNESS: "codex" as const,
    OPENCODE_BIN: "opencode",
    OPENCODE_MODEL: "opencode/deepseek-v4-flash-free",
    MATTERMOST_BOT_DISPLAY: "Felix",
    MATTERMOST_OWNER_DISPLAY: "Owner",
    DISCORD_OWNER_DISPLAY: "Owner",
    SLACK_OWNER_DISPLAY: "Owner",
    SOURCE: "mattermost",
    THREAD_SCAN_INTERVAL_MS: 1000,
    paths: buildWorkspacePaths(workspace),
  } as AppConfig;
}

function makeInput(overrides: Partial<Parameters<typeof createTask>[1]> = {}) {
  return {
    title: "Fix login timeout on staging",
    description: "Users report 30s timeout on the staging login endpoint. Needs investigation.",
    created_by: { source: "mattermost", user_id: "user123" },
    parent_source: "mattermost",
    parent_thread_key: "mattermost:chan456:post789",
    parent_post_id: "post789",
    ...overrides,
  };
}

describe("tasks slice", () => {
  let cfg: AppConfig;
  let cleanupDir: string;

  afterEach(async () => {
    if (cleanupDir) {
      await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("generateTaskId produces a valid id format", () => {
    const id = generateTaskId("Fix Login Timeout!");
    expect(id).toMatch(/^\d+-\S/); // unix_ts-slug
    expect(id).not.toContain(" ");
    expect(id).not.toContain("!");
    expect(id).toBe(id.toLowerCase());
  });

  it("generateTaskId uses the same timestamp prefix within a second", () => {
    const a = generateTaskId("Fix Login");
    const b = generateTaskId("Fix Login");
    const tsA = a.split("-")[0];
    const tsB = b.split("-")[0];
    expect(tsA).toBe(tsB);
  });

  it("createTask writes a valid task record to backlog/", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const input = makeInput();

    const record = await createTask(cfg, input);
    expect(record.id).toMatch(/^\d+-fix-login-timeout-on-staging/);
    expect(record.status).toBe("backlog");
    expect(record.title).toBe(input.title);
    expect(record.description).toBe(input.description);
    expect(record.created_by.source).toBe("mattermost");
    expect(record.created_by.user_id).toBe("user123");
    expect(record.parent_source).toBe("mattermost");
    expect(record.parent_thread_key).toBe("mattermost:chan456:post789");
    expect(record.parent_post_id).toBe("post789");
    expect(record.started_at).toBeNull();
    expect(record.completed_at).toBeNull();
    expect(record.schema_version).toBe(1);
    expect(record.created_at).toBeTruthy();
    expect(record.updated_at).toBeTruthy();

    const filePath = path.join(cfg.paths.tasks, "backlog", `${record.id}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(record.id);
    expect(parsed.status).toBe("backlog");
  });

  it("createTask handles collision by appending suffix", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    const a = await createTask(cfg, makeInput());
    const b = await createTask(cfg, makeInput());

    expect(b.id).not.toBe(a.id);
    expect(b.id).toMatch(/-\d+$/);
    expect(a.id).not.toMatch(/-\d+$/); // first one has no suffix (unless collision was instant)
  });

  it("readTask finds a task in any status dir", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const input = makeInput();
    const created = await createTask(cfg, input);

    const found = await readTask(cfg, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe(input.title);
  });

  it("readTask returns null for nonexistent task", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    const found = await readTask(cfg, "9999999999-nonexistent");
    expect(found).toBeNull();
  });

  it("moveTask transitions a task between status dirs", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const created = await createTask(cfg, makeInput());

    const moved = await moveTask(cfg, created.id, "active");
    expect(moved).not.toBeNull();
    expect(moved!.status).toBe("active");
    expect(moved!.started_at).not.toBeNull();
    expect(moved!.updated_at >= created.updated_at).toBe(true);

    // Old file should be gone
    const oldPath = path.join(cfg.paths.tasks, "backlog", `${created.id}.json`);
    expect(await fs.access(oldPath).then(() => true).catch(() => false)).toBe(false);

    // New file should exist
    const newPath = path.join(cfg.paths.tasks, "active", `${created.id}.json`);
    const raw = await fs.readFile(newPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("active");
  });

  it("moveTask returns null for nonexistent task", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    const moved = await moveTask(cfg, "9999999999-nonexistent", "done");
    expect(moved).toBeNull();
  });

  it("moveTask sets started_at on first active, completed_at on done", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const created = await createTask(cfg, makeInput());
    expect(created.started_at).toBeNull();
    expect(created.completed_at).toBeNull();

    const active = await moveTask(cfg, created.id, "active");
    expect(active!.started_at).not.toBeNull();
    expect(active!.completed_at).toBeNull();

    const done = await moveTask(cfg, created.id, "done");
    expect(done!.completed_at).not.toBeNull();
  });

  it("moveTask preserves started_at on done, does not overwrite", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const created = await createTask(cfg, makeInput());
    const active = await moveTask(cfg, created.id, "active");
    const done = await moveTask(cfg, created.id, "done");

    expect(done!.started_at).toBe(active!.started_at);
  });

  it("moveTask clears timestamps on reopen to backlog", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const created = await createTask(cfg, makeInput());
    await moveTask(cfg, created.id, "active");
    await moveTask(cfg, created.id, "done");

    const reopened = await moveTask(cfg, created.id, "backlog");
    expect(reopened).not.toBeNull();
    expect(reopened!.status).toBe("backlog");
    expect(reopened!.started_at).toBeNull();
    expect(reopened!.completed_at).toBeNull();
  });

  it("listTasks returns all tasks sorted by id descending", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    // Create tasks with slight delay so timestamps differ
    const a = await createTask(cfg, makeInput({ title: "Task A" }));
    await new Promise((r) => setTimeout(r, 1100));
    const b = await createTask(cfg, makeInput({ title: "Task B" }));

    const all = await listTasks(cfg);
    expect(all.length).toBeGreaterThanOrEqual(2);

    // Should be sorted by id descending (newest first)
    const ids = all.map((t: TaskRecord) => t.id);
    expect(ids[0]).toBe(b.id);
  });

  it("listTasks filters by status", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    await createTask(cfg, makeInput({ title: "Backlog Task" }));
    const active = await createTask(cfg, makeInput({ title: "Active Task" }));
    await moveTask(cfg, active.id, "active");

    const backlogs = await listTasks(cfg, { status: "backlog" });
    expect(backlogs.length).toBe(1);
    expect(backlogs[0]!.status).toBe("backlog");

    const actives = await listTasks(cfg, { status: "active" });
    expect(actives.length).toBe(1);
    expect(actives[0]!.status).toBe("active");
  });

  it("listTasks returns empty array when no tasks exist", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    const all = await listTasks(cfg);
    expect(all).toEqual([]);
  });

  it("resolveTaskPath returns dir and record", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);
    const created = await createTask(cfg, makeInput());

    const resolved = await resolveTaskPath(cfg, created.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.dir).toBe(path.join(cfg.paths.tasks, "backlog"));
    expect(resolved!.record.id).toBe(created.id);
  });

  it("resolveTaskPath returns null for nonexistent task", async () => {
    cfg = await makeTestCfg();
    cleanupDir = path.dirname(cfg.WORKSPACE_DIR);
    await ensureWorkspace(cfg.paths);

    const resolved = await resolveTaskPath(cfg, "9999999999-nonexistent");
    expect(resolved).toBeNull();
  });
});
