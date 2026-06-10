import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { buildWorkspacePaths, syncBundledSkills } from "../src/workspace.js";

describe("task-manager skill", () => {
  it("skill file exists and has valid frontmatter", async () => {
    const skillPath = path.join(process.cwd(), "skills", "task-manager", "SKILL.md");
    const raw = await fs.readFile(skillPath, "utf8");
    expect(raw).toContain("id: task-manager");
    expect(raw).toContain("kind: operational");
    expect(raw).toContain("task.create");
    expect(raw).toContain("task.read");
    expect(raw).toContain("make this a task");
    expect(raw).toContain("kanban");
  });

  it("syncBundledSkills copies task-manager into workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-task-skill-"));
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);

    await syncBundledSkills(paths);

    const destPath = path.join(paths.skills, "task-manager", "SKILL.md");
    const raw = await fs.readFile(destPath, "utf8");
    expect(raw).toContain("id: task-manager");

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("loadSkills parses the task-manager skill correctly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-task-load-"));
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);

    await syncBundledSkills(paths);
    const cfg = { WORKSPACE_DIR: workspace, paths } as never;
    const skills = await loadSkills(cfg);

    const taskSkill = skills.find((s) => s.id === "task-manager");
    expect(taskSkill).toBeDefined();
    expect(taskSkill!.permissions).toContain("task-manager:task.create");
    expect(taskSkill!.permissions).toContain("task-manager:task.read");

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("references workspace paths relative to WORKSPACE_DIR", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain('TASKS_DIR="${WORKSPACE_DIR}/tasks"');
    expect(raw).not.toContain("/home/agent/workspace/tasks");
  });

  it("uses jq -n for JSON construction, not heredocs", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("jq -n");
    // Should not have unquoted heredocs for JSON
    expect(raw).not.toMatch(/cat\s*>\s*"\$TASKS_DIR.*<<\s*EOF/);
  });

  it("documents DRAFT_TITLE and DRAFT_DESC confirmation format", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("DRAFT_TITLE:");
    expect(raw).toContain("DRAFT_DESC:");
    expect(raw).toContain("grep -A50 \"DRAFT_TITLE:\"");
  });

  it("documents the board markdown table format", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("| Status    | Task ID");
    expect(raw).toContain("for d in backlog active done cancelled blocked paused; do");
  });

  it("documents all 6 statuses", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("backlog");
    expect(raw).toContain("active");
    expect(raw).toContain("done");
    expect(raw).toContain("cancelled");
    expect(raw).toContain("blocked");
    expect(raw).toContain("paused");
  });

  it("includes Mattermost notification curl pattern", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("MATTERMOST_URL/api/v4/posts");
    expect(raw).toContain("MATTERMOST_TOKEN");
  });

  it("documents edge cases in checks section", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("Never guess task IDs");
    expect(raw).toContain("always confirm before creating");
    expect(raw).toContain("reopen");
    expect(raw).toContain("backlog");
  });

  it("documents timestamp rules for status transitions", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("started_at");
    expect(raw).toContain("completed_at");
    expect(raw).toContain("→ active");
    expect(raw).toContain("→ done");
    expect(raw).toContain("→ backlog (reopen)");
  });

  it("includes out of scope section", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "task-manager", "SKILL.md"), "utf8");
    expect(raw).toContain("Out of scope");
    expect(raw).toContain("assignments");
  });
});
