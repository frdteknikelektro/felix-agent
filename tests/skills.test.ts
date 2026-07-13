import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { buildWorkspacePaths } from "../src/workspace.js";

describe("skills", () => {
  it("loads skill metadata from disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-"));
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);
    const skillsDir = path.join(paths.skills, "demo");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "SKILL.md"),
      `---\nname: demo\ndescription: test\nmetadata:\n  permissions: repo.read\n---\n\nbody\n`,
      "utf8",
    );
    const cfg = {
      WORKSPACE_DIR: workspace,
      paths,
    } as never;
    const skills = await loadSkills(cfg);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("demo");
    expect(skills[0]?.permissions).toEqual(["demo:repo.read"]);
  });
});
