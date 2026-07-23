import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync(path.join(process.cwd(), "skills", "memory", "SKILL.md"), "utf8");

describe("always-on Memory skill contract", () => {
  it("defines the exact fresh-session working set and on-demand older recall", () => {
    expect(skill).toContain("Memory is always on");
    expect(skill).toContain("today's and yesterday's");
    expect(skill).toContain("latest completed file in `memory/weekly/`");
    expect(skill).toContain("latest completed file in `memory/monthly/`");
    expect(skill).toContain("Search older active Memory only when");
  });

  it("gates direct mutations without prompting for implicit capture", () => {
    expect(skill).toContain("`write` — Change `MEMORY.md`");
    expect(skill).toContain("Ignore implicit Memory-worthy content");
    expect(skill).toContain("explicit remember, correct, or forget request");
  });

  it("covers human judgment, exclusions, conflicts, constraints, and loss-aware compaction", () => {
    expect(skill).toContain("Human judgment");
    expect(skill).toContain("Do not store secrets");
    expect(skill).toContain("unresolved contradictions");
    expect(skill).toContain("Include an expiry for temporary constraints");
    expect(skill).toContain("soft 5 KB target");
    expect(skill).toContain("Never hard");
  });

  it("limits disclosure and forgets across every active Memory tier", () => {
    expect(skill).toContain("`is_owner: true`");
    expect(skill).toContain("Other contacts may receive only relevant, non-sensitive facts");
    expect(skill).toContain("semantic, daily, weekly, and monthly");
    expect(skill).toContain("does not alter source sessions");
    expect(skill).toContain("inactive Legacy memory");
  });
});
