import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/slices/skills/index.js";
import { syncBundledSkills } from "../src/workspace.js";
import {
  PERSONALITY_COMMUNICATION_STYLES,
  PERSONALITY_ROLES,
  PERSONALITY_TONES,
} from "../src/slices/personality/index.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("personality skill", () => {
  it("loads a permission-free natural-language personality workflow", async () => {
    const cfg = await makeTestConfig("felix-personality-skill-");
    await syncBundledSkills(cfg.paths);

    const skill = (await loadSkills(cfg)).find(
      (candidate) => candidate.id === "personality",
    );

    expect(skill?.description).toMatch(/change|edit|reset/i);
    expect(skill?.permissions).toEqual([]);
    expect(skill?.body).toContain("is_owner: true");
    expect(skill?.body).toContain("PERSONALITY_CHANGE");
    expect(skill?.body).toContain("mode: reset");
    expect(skill?.body).toContain("controlled vocabulary");
    expect(skill?.body).toContain("Use short paragraphs");
    expect(skill?.body).toContain("Write concise responses");

    const listedValues = (prefix: string): string[] => {
      const line = skill!.body.split(/\r?\n/).find((item) =>
        item.startsWith(prefix),
      );
      expect(line, prefix).toBeDefined();
      return line!.slice(prefix.length).replace(/\.$/, "").split("; ");
    };
    expect(listedValues("- **Role (choose one):** ")).toEqual(
      PERSONALITY_ROLES,
    );
    expect(listedValues("- **Tone (choose one or more):** ")).toEqual(
      PERSONALITY_TONES,
    );
    expect(
      listedValues("- **Communication Style (choose one or more):** "),
    ).toEqual(PERSONALITY_COMMUNICATION_STYLES);
  });
});
