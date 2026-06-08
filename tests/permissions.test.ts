import { describe, expect, it } from "vitest";
import { namespacePermissions } from "../src/engine.js";

describe("namespacePermissions", () => {
  it("prepends skill id to bare permissions", () => {
    expect(namespacePermissions("install-tool", ["install.run"])).toEqual(["install-tool:install.run"]);
  });

  it("leaves already-namespaced permissions unchanged", () => {
    expect(namespacePermissions("install-tool", ["install-tool:install.run"])).toEqual([
      "install-tool:install.run",
    ]);
  });

  it("handles multiple permissions, mixed bare and namespaced", () => {
    expect(namespacePermissions("shell", ["shell:run", "exec"])).toEqual(["shell:run", "shell:exec"]);
  });

  it("returns empty array for no permissions", () => {
    expect(namespacePermissions("any-skill", [])).toEqual([]);
  });
});
