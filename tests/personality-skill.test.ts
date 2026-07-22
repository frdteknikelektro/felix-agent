import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { syncBundledSkills } from "../src/workspace.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("personality skill", () => {
  it("loads as a bundled permission-free skill", async () => {
    const cfg = await makeTestConfig("felix-personality-skill-");
    await syncBundledSkills(cfg.paths);

    const skill = (await loadSkills(cfg)).find(
      (candidate) => candidate.id === "personality",
    );

    expect(skill).toMatchObject({
      id: "personality",
      permissions: [],
    });
  });
});
