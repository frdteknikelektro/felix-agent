import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("install-tool skill", () => {
  it("installs tools into workspace runtime paths that are on PATH", async () => {
    const skill = await fs.readFile("skills/install-tool/SKILL.md", "utf8");

    expect(skill).toContain("workspace/runtime/bin/");
    expect(skill).toContain("workspace/runtime/tools/<name>/");
    expect(skill).toContain('WORKSPACE_RUNTIME="${WORKSPACE_DIR}/runtime"');
    expect(skill).toContain('WORKSPACE_BIN="${WORKSPACE_RUNTIME}/bin"');
    expect(skill).toContain('WORKSPACE_TOOLS="${WORKSPACE_RUNTIME}/tools"');
    // Both the shared bin dir and the npm-install bin dir are documented as on PATH.
    expect(skill).toContain("workspace/runtime/npm/bin");
    expect(skill).toContain("are on `PATH`");

    expect(skill).not.toContain("workspace/bin/");
    expect(skill).not.toContain("workspace/tools/<name>/");
    expect(skill).not.toContain('WORKSPACE_BIN="${WORKSPACE_DIR}/bin"');
    expect(skill).not.toContain('WORKSPACE_TOOLS="${WORKSPACE_DIR}/tools"');
  });
});
