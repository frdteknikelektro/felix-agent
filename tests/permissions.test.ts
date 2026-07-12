import { describe, expect, it } from "vitest";
import { namespacePermissions } from "../src/slices/approvals/index.js";
import { grantsForPermission, permissionSatisfied } from "../src/slices/skills/index.js";

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

describe("permissionSatisfied", () => {
  // The database skill's real declaration shape: bare names containing dots
  // alongside scoped names.
  const DECLARED = ["database:connection.read", "database:connection.write", "database:read.*", "database:write.*"];

  it("matches a bare permission exactly", () => {
    expect(permissionSatisfied(["deploy:read"], "deploy:read", ["deploy:read"])).toBe(true);
    expect(permissionSatisfied(["deploy:read"], "deploy:run", ["deploy:read", "deploy:run"])).toBe(false);
  });

  it("matches a concrete scope exactly", () => {
    expect(permissionSatisfied(["database:read.prod-pg"], "database:read.prod-pg", DECLARED)).toBe(true);
    expect(permissionSatisfied(["database:read.prod-pg"], "database:read.staging", DECLARED)).toBe(false);
  });

  it("declared wildcard grant covers any concrete scope of that name", () => {
    expect(permissionSatisfied(["database:read.*"], "database:read.prod-pg", DECLARED)).toBe(true);
    expect(permissionSatisfied(["database:read.*"], "database:read.*", DECLARED)).toBe(true);
    expect(permissionSatisfied(["database:write.*"], "database:read.prod-pg", DECLARED)).toBe(false);
  });

  it("bare and scoped never satisfy each other", () => {
    expect(permissionSatisfied(["database:read"], "database:read.prod-pg", DECLARED)).toBe(false);
    expect(permissionSatisfied(["database:read.prod-pg"], "database:read", DECLARED)).toBe(false);
    expect(permissionSatisfied(["database:read.*"], "database:read", DECLARED)).toBe(false);
  });

  it("a concrete scoped grant does not satisfy a wildcard request", () => {
    expect(permissionSatisfied(["database:read.prod-pg"], "database:read.*", DECLARED)).toBe(false);
  });

  it("partial patterns are not wildcards — exact match only", () => {
    expect(permissionSatisfied(["database:read.staging-*"], "database:read.staging-a", DECLARED)).toBe(false);
    expect(permissionSatisfied(["database:read.staging-*"], "database:read.staging-*", DECLARED)).toBe(true);
  });

  it("a pseudo-wildcard grant over a dotted bare name authorizes nothing", () => {
    // connection.read is declared bare; connection.* is not a declared wildcard
    expect(permissionSatisfied(["database:connection.*"], "database:connection.read", DECLARED)).toBe(false);
    expect(permissionSatisfied(["database:connection.*"], "database:connection.write", DECLARED)).toBe(false);
  });

  it("a sub-scope pseudo-wildcard grant authorizes nothing", () => {
    // read.staging.* is not the declared read.* wildcard
    expect(permissionSatisfied(["database:read.staging.*"], "database:read.staging.x", DECLARED)).toBe(false);
    expect(permissionSatisfied(["database:read.staging.*"], "database:read.staging.*", DECLARED)).toBe(true);
  });

  it("an undeclared permission falls back to exact match only", () => {
    expect(permissionSatisfied(["mystery:thing.*"], "mystery:thing.a", [])).toBe(false);
    expect(permissionSatisfied(["mystery:thing.a"], "mystery:thing.a", [])).toBe(true);
  });

  it("overlapping declared wildcards match regardless of declaration order", () => {
    // read.x.* declared before read.* — a read.* holder must still be covered
    const overlapping = ["database:read.x.*", "database:read.*"];
    expect(permissionSatisfied(["database:read.*"], "database:read.x.y", overlapping)).toBe(true);
    expect(permissionSatisfied(["database:read.x.*"], "database:read.x.y", overlapping)).toBe(true);
    expect(permissionSatisfied(["database:read.x.*"], "database:read.other", overlapping)).toBe(false);
  });
});

describe("grantsForPermission", () => {
  it("bare declaration matches only itself", () => {
    expect(grantsForPermission(["deploy:read", "deploy:run"], "deploy:read")).toEqual(["deploy:read"]);
    expect(grantsForPermission(["deploy:run"], "deploy:read")).toEqual([]);
  });

  it("scoped declaration collects concrete scopes and the wildcard", () => {
    const granted = ["database:read.prod-pg", "database:read.*", "database:write.x", "deploy:read"];
    expect(grantsForPermission(granted, "database:read.*")).toEqual([
      "database:read.prod-pg",
      "database:read.*",
    ]);
  });

  it("scoped declaration ignores a bare grant of the same name", () => {
    expect(grantsForPermission(["database:read"], "database:read.*")).toEqual([]);
  });

  it("scoped declaration excludes pseudo-wildcard grants the matcher won't honor", () => {
    const granted = ["database:read.staging.*", "database:read.prod-pg", "database:read.*"];
    expect(grantsForPermission(granted, "database:read.*")).toEqual([
      "database:read.prod-pg",
      "database:read.*",
    ]);
  });
});
