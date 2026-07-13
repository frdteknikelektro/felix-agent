import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { buildWorkspacePaths, syncBundledSkills } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("task-manager skill", () => {
  it("declares its lifecycle, permissions, and deterministic writer", async () => {
    const raw = await fs.readFile("skills/task-manager/SKILL.md", "utf8");

    expect(raw).toContain("name: task-manager");
    expect(raw).toContain("kind: operational");
    expect(raw).toContain("task.create");
    expect(raw).toContain("task.read");
    expect(raw).toContain("make this a task");
    expect(raw).toContain("kanban");
    expect(raw).toContain('TASK_CLI="${WORKSPACE_DIR}/.agents/skills/task-manager/task.mjs"');
    expect(raw).toContain("jq -n");
    expect(raw).toContain("always confirms before creating");
    expect(raw).toContain("reopen");
    expect(raw).not.toContain("MATTERMOST_TOKEN");
    expect(raw).not.toContain("curl -sS -X POST");
  });

  it("syncs and parses the skill with namespaced permissions", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);

    await syncBundledSkills(paths);
    const skills = await loadSkills({ WORKSPACE_DIR: workspace, paths } as never);
    const taskSkill = skills.find((skill) => skill.id === "task-manager");

    expect(await fs.stat(path.join(paths.skills, "task-manager", "task.mjs"))).toBeTruthy();
    expect(taskSkill?.permissions).toEqual([
      "task-manager:task.create",
      "task-manager:task.read",
    ]);
  });

  it("runs create → active → done → backlog without corrupting timestamps or string post IDs", async () => {
    const root = await makeTempDir();
    const env = { ...process.env, WORKSPACE_DIR: root };
    const cli = path.resolve("skills/task-manager/task.mjs");
    const payload = {
      title: "Fix | API",
      description: "Preserve\nmultiline context",
      source: "mattermost",
      user_id: "user-1",
      parent_thread_key: "mattermost:channel:post",
      parent_post_id: "nonnumeric-post-id",
    };

    const created = await runCli(cli, ["create"], env, JSON.stringify(payload));
    const id = created.stdout.match(/`([^`]+)`/)?.[1];
    expect(id).toBeTruthy();

    expect((await runCli(cli, ["transition", id!, "start"], env)).stdout).toContain("→ active");
    expect((await runCli(cli, ["transition", id!, "done"], env)).stdout).toContain("→ done");
    const done = JSON.parse(await fs.readFile(path.join(root, "tasks", "done", `${id}.json`), "utf8"));
    expect(done.parent_post_id).toBe("nonnumeric-post-id");
    expect(done.started_at).toMatch(/Z$/);
    expect(done.completed_at).toMatch(/Z$/);

    expect((await runCli(cli, ["transition", id!, "reopen"], env)).stdout).toContain("→ backlog");
    const reopened = JSON.parse(await fs.readFile(path.join(root, "tasks", "backlog", `${id}.json`), "utf8"));
    expect(reopened.started_at).toBeNull();
    expect(reopened.completed_at).toBeNull();
  });

  it("renders a safe markdown board and refuses path-like task IDs", async () => {
    const root = await makeTempDir();
    const env = { ...process.env, WORKSPACE_DIR: root };
    const cli = path.resolve("skills/task-manager/task.mjs");
    await runCli(cli, ["create"], env, JSON.stringify({
      title: "A | B",
      description: "test",
      source: "test",
      user_id: "u",
      parent_thread_key: "test:thread",
    }));

    expect((await runCli(cli, ["board"], env)).stdout).toContain("A \\| B");
    await expect(runCli(cli, ["show", "../secret"], env)).rejects.toThrow("A valid task ID is required.");
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-task-skill-"));
  temporaryDirectories.push(dir);
  return dir;
}

function runCli(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `task CLI exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}
