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

  it("copies reference skills but does not load disabled ones", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-reference-"));
    const workspace = path.join(root, "workspace");
    const sourceSkills = path.join(root, "skills");
    for (const [name, frontmatter] of [
      ["general", "name: general"],
      ["memory", "id: memory\nname: Memory Wiki"],
      ["template-skill", "id: template-skill\nname: Template Skill\nenabled: false"],
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
    expect(loaded.map((s) => s.id)).toEqual(["general", "memory"]);
  });

  it("keeps the general skill conservative and reply-only", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "skills", "general", "SKILL.md"), "utf8");
    expect(raw).toContain("Reply-only.");
    expect(raw).toContain("clarifying question");
    expect(raw).toContain("defer to that skill");
    expect(raw).not.toContain("troubleshoot");
    expect(raw).not.toContain("How do I restart the container?");
    expect(raw).not.toContain("Can you help me understand this error?");
  });
});
