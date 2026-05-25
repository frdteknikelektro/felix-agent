import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/skills.js";

describe("skills", () => {
  it("loads skill metadata from disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-"));
    const workspace = path.join(root, "workspace");
    const skillsDir = path.join(workspace, "skills", "demo");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "SKILL.md"),
      `---\nid: demo\nname: Demo Skill\ndescription: test\npermissions:\n  - repo.read\n---\n\nbody\n`,
      "utf8",
    );
    const cfg = {
      WORKSPACE_DIR: workspace,
      paths: {
        root: workspace,
        raw: path.join(workspace, "raw"),
        threads: path.join(workspace, "threads"),
        contacts: path.join(workspace, "contacts"),
        skills: path.join(workspace, "skills"),
        logs: path.join(workspace, "logs"),
        media: path.join(workspace, "media"),
        codex: path.join(workspace, "codex"),
        health: path.join(workspace, ".health"),
      },
    } as never;
    const skills = await loadSkills(cfg);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("demo");
    expect(skills[0]?.permissions).toEqual(["repo.read"]);
  });
});
