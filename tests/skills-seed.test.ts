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

  it("skips gated skills and removes any stale copy from the catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-skills-gate-"));
    const workspace = path.join(root, "workspace");
    const sourceSkills = path.join(root, "skills");
    for (const name of ["general", "9router"]) {
      const dir = path.join(sourceSkills, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
    }

    const paths = buildWorkspacePaths(workspace);
    // Seed a stale 9router copy to prove a disabled skill gets cleaned up.
    await fs.mkdir(path.join(paths.skills, "9router"), { recursive: true });
    await fs.writeFile(path.join(paths.skills, "9router", "SKILL.md"), "stale", "utf8");

    await syncBundledSkills(paths, { skip: (name) => name === "9router" }, sourceSkills);

    expect(await fs.stat(path.join(paths.skills, "general", "SKILL.md"))).toBeTruthy();
    await expect(fs.stat(path.join(paths.skills, "9router"))).rejects.toThrow();
    const loaded = await loadSkills({ WORKSPACE_DIR: workspace, paths } as never);
    expect(loaded.map((s) => s.id)).toEqual(["general"]);
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
