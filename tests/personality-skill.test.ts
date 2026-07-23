import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { syncBundledSkills } from "../src/workspace.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("personality skill", () => {
  it("loads a permission-free direct-edit workflow", async () => {
    const cfg = await makeTestConfig("felix-personality-skill-");
    await syncBundledSkills(cfg.paths);

    const skill = (await loadSkills(cfg)).find(
      (candidate) => candidate.id === "personality",
    );

    expect(skill?.description).toMatch(/directly edit|reset/i);
    expect(skill?.permissions).toEqual([]);
    expect(skill?.body).toContain("is_owner: true");
    expect(skill?.body).toContain("If `is_owner` is false, refuse briefly");
    expect(skill?.body).toContain("perform the requested edit directly");
    expect(skill?.body).toContain("free-form Markdown edit");
    expect(skill?.body).toContain("Preserve content the Owner did not ask to change");
    expect(skill?.body).toContain("temporary file in the same directory");
    expect(skill?.body).toMatch(/re-read the file and verify/i);
    expect(skill?.body).toContain("only the normal `FELIX_REPLY` contract");
    expect(skill?.body).toContain("delete workspace-root `PERSONALITY.md`");
  });
});
