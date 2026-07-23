import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { buildWorkspacePaths, syncBundledSkills } from "../src/workspace.js";

describe("bundled skills", () => {
  it("copies bundled skills into the workspace skill directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-seed-"));
    const workspace = path.join(root, "workspace");
    const sourceSkills = path.join(root, "skills");
    const bundledGeneral = path.join(sourceSkills, "general");
    await fs.mkdir(bundledGeneral, { recursive: true });
    await fs.writeFile(
      path.join(bundledGeneral, "SKILL.md"),
      `---\nname: general\ndescription: Default skill\nkind: general\n---\n\n# General Skill\n`,
      "utf8",
    );

    const paths = buildWorkspacePaths(workspace);

    await syncBundledSkills(paths, {}, sourceSkills);
    const loaded = await loadSkills({ WORKSPACE_DIR: workspace, paths } as never);

    expect(await fs.stat(path.join(paths.skills, "general", "SKILL.md"))).toBeTruthy();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("general");
  });

  it("copies reference skills and loads all of them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-reference-"));
    const workspace = path.join(root, "workspace");
    const sourceSkills = path.join(root, "skills");
    for (const [name, frontmatter] of [
      ["general", "name: general"],
      ["memory", "name: memory"],
      ["template-skill", "name: template-skill"],
    ]) {
      const dir = path.join(sourceSkills, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`, "utf8");
    }

    const paths = buildWorkspacePaths(workspace);

    await syncBundledSkills(paths, {}, sourceSkills);

    expect(await fs.stat(path.join(paths.skills, "general", "SKILL.md"))).toBeTruthy();
    expect(await fs.stat(path.join(paths.skills, "memory", "SKILL.md"))).toBeTruthy();
    expect(await fs.stat(path.join(paths.skills, "template-skill", "SKILL.md"))).toBeTruthy();
    const loaded = await loadSkills({ WORKSPACE_DIR: workspace, paths } as never);
    expect(loaded.map((s) => s.id)).toEqual(["general", "memory", "template-skill"]);
  });

  it("keeps general computer use bounded to ordinary workspace work", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "general", "SKILL.md"), "utf8");
    expect(raw).toContain("No permissions required");
    expect(raw).toContain("File Collection");
    expect(raw).toContain("Session work");
    expect(raw).toContain("defer to `software-development`");
    expect(raw).toContain("explicit confirmation");
    expect(raw).toContain("Skills cannot override");
    expect(raw).not.toContain("repo.write");
  });
});
